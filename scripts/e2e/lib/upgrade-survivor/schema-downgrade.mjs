// Genuine fork-point T -> tested merge T+1 -> projected rollback state -> genuine T.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createReaderFixture, smokeReaderFixture } from "./reader-fixture.mjs";
import { startNodeFixture } from "./release-process.mjs";
import {
  inspectFixtureStores,
  restoreRaisedFloorStores,
  snapshotFixtureStores,
} from "./schema-store-facts.mjs";

const barrierPath = fileURLToPath(new URL("./schema-downgrade-barrier.mjs", import.meta.url));
const positiveVersion = (value) => Number.isSafeInteger(value) && value > 0;
const errorText = (error) => String(error?.message ?? error).slice(-4096);
const fileSha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The controller and its receipt consumer use the same classification of observed facts.
// ReaderFloor capability comes from candidate source provenance, not column presence:
// strict writers legitimately omit a floor, meaning their current version is required.
/**
 * @param {{
 *   before: ReturnType<typeof snapshotFixtureStores>,
 *   after: ReturnType<typeof inspectFixtureStores>,
 *   schemaVersions: { state: number, agent: number },
 *   readerFloorSupported?: boolean,
 *   smoke?: Partial<Awaited<ReturnType<typeof smokeReaderFixture>>> | null,
 *   projection?: ReturnType<typeof restoreRaisedFloorStores> | null,
 * }} params
 */
export function classifySchemaDowngrade({
  before,
  after,
  schemaVersions,
  readerFloorSupported = false,
  smoke = null,
  projection = null,
}) {
  const mode = readerFloorSupported ? "enforced" : "report-only";
  const structuralFailures = [];
  const compatibilityFailures = [];
  const fail = (relativePath, message) => structuralFailures.push({ relativePath, message });
  const previous = new Map(before.map((store) => [store.relativePath, store]));
  const current = new Map(after.map((store) => [store.relativePath, store]));
  if (previous.size !== before.length || current.size !== after.length) {
    fail(null, "Duplicate physical store paths in fixture metadata");
  }
  if (!before.length || !after.length) {
    fail(null, "Fixture must contain committed SQLite stores before and after candidate boot");
  }
  for (const role of ["shared", "agent"]) {
    const target = schemaVersions[role === "shared" ? "state" : "agent"];
    if (!positiveVersion(target)) {
      fail(null, `Invalid candidate ${role} schema target`);
    }
    if (!before.some((store) => store.role === role)) {
      fail(null, `T fixture did not seed a ${role} store`);
    }
  }
  for (const store of [...before, ...after]) {
    if (!["shared", "agent"].includes(store.role) || !positiveVersion(store.version)) {
      fail(store.relativePath, "Invalid committed store role/version");
    }
    if (!positiveVersion(store.minReader) || store.minReader > store.version) {
      fail(store.relativePath, "Invalid effective reader floor");
    }
  }
  const stores = after.map((store) => {
    const prior = previous.get(store.relativePath);
    const target = schemaVersions[store.role === "shared" ? "state" : "agent"];
    const advanced =
      !prior ||
      prior.version !== store.version ||
      prior.role !== store.role ||
      prior.minReader !== store.minReader ||
      prior.hasMinReader !== store.hasMinReader;
    if (!prior) {
      fail(store.relativePath, "Candidate created a store without a T preimage");
    }
    if (prior && prior.role !== store.role) {
      fail(store.relativePath, "Candidate changed the store owner");
    }
    if (prior && store.version < prior.version) {
      fail(store.relativePath, "Candidate regressed the committed schema");
    }
    if (advanced && store.version !== target) {
      fail(store.relativePath, `Advanced store did not reach candidate target ${target}`);
    }
    if (store.integrity !== "ok") {
      fail(store.relativePath, "Post-candidate integrity check did not pass");
    }
    return {
      relativePath: store.relativePath,
      role: store.role,
      target,
      status: advanced ? "advanced" : "untouched",
      beforeVersion: prior?.version ?? null,
      afterVersion: store.version,
      beforeFloor: prior?.minReader ?? null,
      afterFloor: store.minReader,
      beforeHasMinReader: prior?.hasMinReader ?? null,
      afterHasMinReader: store.hasMinReader,
      raised: Boolean(prior && store.minReader > prior.minReader),
      integrity: store.integrity,
    };
  });
  for (const store of before) {
    if (!current.has(store.relativePath)) {
      fail(store.relativePath, "Candidate removed a seeded store");
    }
  }
  if (projection && projection.unrestoredRaised.length) {
    fail(null, "Default rollback projection left raised-floor stores unrestored");
  }
  if (smoke?.failureKind === "setup" || smoke?.gateway?.error) {
    fail(null, smoke.failure?.message ?? smoke.gateway?.error ?? "T reader setup failed");
  } else if (smoke && smoke.status !== "passed") {
    // All raised stores are restored by the default projection. Even an authentic
    // T schema refusal is a failure here: it cannot excuse an unraised store.
    compatibilityFailures.push({
      message: smoke.failure?.message ?? "T reader smoke did not pass",
    });
  }
  const failed =
    structuralFailures.length > 0 || (readerFloorSupported && compatibilityFailures.length > 0);
  const result = failed
    ? "failed"
    : !smoke
      ? "pending"
      : readerFloorSupported
        ? "passed"
        : "report-only";
  return {
    mode,
    result,
    readerFloorSupported,
    stores,
    structuralFailures,
    compatibilityFailures,
    gate: {
      enforced: readerFloorSupported,
      passed: result === "passed" || result === "report-only",
      result,
      failures: [...structuralFailures, ...(readerFloorSupported ? compatibilityFailures : [])],
    },
  };
}

function readBuild(codeRoot, expected) {
  const actual = JSON.parse(
    fs.readFileSync(path.join(codeRoot, "dist", "build-info.json"), "utf8"),
  );
  for (const key of ["version", "buildId", "commit"]) {
    assert(
      typeof expected?.[key] === "string" && expected[key],
      `Missing expected ${key}: ${codeRoot}`,
    );
    assert.equal(actual[key], expected[key], `Wrong ${key} in built root ${codeRoot}`);
  }
  return actual;
}

async function waitForBarrier(candidate, sentinel, port) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const mark = JSON.parse(fs.readFileSync(sentinel, "utf8"));
      assert.equal(mark.port, port, "Candidate barrier intercepted the wrong port");
      assert(
        Number.isSafeInteger(mark.pid) && mark.pid > 0,
        "Candidate barrier did not identify its process",
      );
      return mark;
    } catch (error) {
      // writeFileSync creates the sentinel before writing its small JSON payload.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (candidate.error()) {
      throw candidate.error();
    }
    if (candidate.child.exitCode !== null || candidate.child.signalCode !== null) {
      const exit = await candidate.done;
      throw new Error(
        `Candidate exited before the Gateway listen barrier: ${JSON.stringify(exit)}`,
      );
    }
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Candidate did not reach the exact Gateway listen barrier within 120 seconds");
}

export async function runSchemaDowngrade({
  previousRoot,
  candidateRoot,
  previousBuild,
  candidateBuild,
  root,
  artifacts,
  env,
}) {
  fs.mkdirSync(artifacts, { recursive: true });
  const receipt = {
    scope: "genuine-previous-reader-projected-rollback",
    result: "setup-failed",
    mode: candidateBuild?.readerFloorSupported === true ? "enforced" : "report-only",
    readerFloorSupported: candidateBuild?.readerFloorSupported === true,
    floorCapabilitySource: "candidate-source-contract-with-matching-build-provenance",
    expectedBuilds: {
      previous: { ...previousBuild, root: previousRoot },
      candidate: { ...candidateBuild, root: candidateRoot },
    },
    fixture: null,
    config: null,
    before: [],
    after: [],
    candidate: null,
    projection: null,
    smoke: null,
    gate: {
      enforced: candidateBuild?.readerFloorSupported === true,
      passed: false,
      result: "setup-failed",
      failures: [],
    },
  };
  let candidate;
  /** @type {Error | undefined} */
  let failure;
  const save = () => {
    const log = [
      receipt.setupFailure?.gateway?.output,
      receipt.candidate?.outputTail,
      receipt.smoke?.gateway?.output,
      receipt.error,
    ]
      .filter(Boolean)
      .join("\n");
    fs.writeFileSync(
      path.join(artifacts, "schema-downgrade.log"),
      Buffer.from(log).subarray(-65536),
    );
    fs.writeFileSync(
      path.join(artifacts, "schema-downgrade.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  };
  try {
    assert.notEqual(
      fs.realpathSync(previousRoot),
      fs.realpathSync(candidateRoot),
      "T and T+1 must be distinct built roots",
    );
    receipt.previousBuild = readBuild(previousRoot, previousBuild);
    receipt.candidateBuild = readBuild(candidateRoot, candidateBuild);
    assert.notEqual(
      previousBuild.commit,
      candidateBuild.commit,
      "T and T+1 must be genuine different commits",
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(candidateRoot, "package.json"), "utf8"));
    const schemaVersions = manifest.openclaw?.schemaVersions;
    assert.equal(
      manifest.version,
      candidateBuild.version,
      "Candidate manifest/build version mismatch",
    );
    assert(schemaVersions, "Candidate package is missing schema targets");
    receipt.schemaVersions = schemaVersions;
    fs.mkdirSync(root, { recursive: true });
    const fixture = await createReaderFixture({
      codeRoot: previousRoot,
      root: path.join(root, "fixture"),
      port: 38789,
      env,
    });
    receipt.fixture = {
      home: fixture.home,
      stateDir: fixture.stateDir,
      configPath: fixture.configPath,
      port: fixture.port,
      build: fixture.build,
      schemaVersions: fixture.schemaVersions,
    };
    const baselineRoot = path.join(artifacts, "schema-downgrade-baseline");
    // createReaderFixture has stopped and reaped T before returning.
    receipt.before = snapshotFixtureStores(fixture.stateDir, baselineRoot);
    const configPreimage = path.join(root, "config.before-candidate");
    fs.copyFileSync(fixture.configPath, configPreimage, fs.constants.COPYFILE_EXCL);
    receipt.config = {
      path: fixture.configPath,
      beforeSha256: fileSha256(configPreimage),
      afterCandidateSha256: null,
      restoredSha256: null,
    };
    save();
    const sentinel = path.join(root, "candidate-prelisten.json");
    fs.rmSync(sentinel, { force: true });
    const args = [
      path.join(candidateRoot, "openclaw.mjs"),
      "gateway",
      "run",
      "--port",
      String(fixture.port),
    ];
    receipt.candidate = {
      invocation: {
        executable: process.execPath,
        args,
        port: fixture.port,
        launcherForwarded: true,
        barrierPath,
      },
      sentinel,
      barrier: null,
      exit: null,
      outputTail: "",
    };
    candidate = startNodeFixture(args, {
      ...fixture.env,
      OPENCLAW_RELEASE_LAUNCHER_FORWARDED: "1",
      OPENCLAW_SCHEMA_DOWNGRADE_PORT: String(fixture.port),
      OPENCLAW_SCHEMA_DOWNGRADE_SENTINEL: sentinel,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--import=${JSON.stringify(barrierPath)}`]
        .filter(Boolean)
        .join(" "),
    });
    try {
      receipt.candidate.barrier = await waitForBarrier(candidate, sentinel, fixture.port);
    } finally {
      // No SQLite opens, copies, or recovery of originals until the whole group is dead.
      receipt.candidate.exit = await candidate.stop("SIGKILL");
      receipt.candidate.outputTail = candidate.output();
    }
    receipt.after = inspectFixtureStores(
      fixture.stateDir,
      path.join(artifacts, "schema-downgrade-post-candidate"),
    );
    receipt.config.afterCandidateSha256 = fileSha256(fixture.configPath);
    Object.assign(
      receipt,
      classifySchemaDowngrade({
        before: receipt.before,
        after: receipt.after,
        schemaVersions,
        readerFloorSupported: receipt.readerFloorSupported,
      }),
    );
    // Persist the exact post-candidate observation before any restoration.
    save();
    assert.equal(
      receipt.structuralFailures.length,
      0,
      "Candidate store structure/target verification failed",
    );
    receipt.projection = restoreRaisedFloorStores(
      fixture.stateDir,
      baselineRoot,
      receipt.before,
      receipt.after,
    );
    assert.equal(
      receipt.projection.unrestoredRaised.length,
      0,
      "Rollback projection must restore every raised-floor store",
    );
    // The real launcher also restores config; its version stamp is not a SQLite reader floor.
    const configRestore = path.join(root, "config.restore");
    fs.copyFileSync(configPreimage, configRestore, fs.constants.COPYFILE_EXCL);
    fs.renameSync(configRestore, fixture.configPath);
    receipt.config.restoredSha256 = fileSha256(fixture.configPath);
    assert.equal(
      receipt.config.restoredSha256,
      receipt.config.beforeSha256,
      "Rollback projection did not restore the previous config",
    );
    save();
    try {
      receipt.smoke = await smokeReaderFixture(fixture, previousRoot);
    } catch (error) {
      if (!error.receipt) {
        throw error;
      }
      receipt.smoke = error.receipt;
    }
    Object.assign(
      receipt,
      classifySchemaDowngrade({
        before: receipt.before,
        after: receipt.after,
        schemaVersions,
        readerFloorSupported: receipt.readerFloorSupported,
        projection: receipt.projection,
        smoke: receipt.smoke,
      }),
    );
    if (!receipt.gate.passed) {
      failure = new Error("Schema downgrade gate failed; see schema-downgrade.json");
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(errorText(error), { cause: error });
    receipt.error = errorText(error);
    if (error?.receipt) {
      receipt.setupFailure = error.receipt;
    }
    if (receipt.result !== "failed") {
      receipt.result = "setup-failed";
    }
    receipt.gate = {
      ...receipt.gate,
      passed: false,
      result: receipt.result,
      failures: [...receipt.gate.failures, { message: receipt.error }],
    };
  } finally {
    try {
      if (candidate) {
        await candidate.stop("SIGKILL");
        receipt.candidate.outputTail = candidate.output();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(errorText(error), { cause: error });
      receipt.result = "setup-failed";
      receipt.error = errorText(error);
      receipt.gate = {
        ...receipt.gate,
        passed: false,
        result: "setup-failed",
        failures: [...receipt.gate.failures, { message: receipt.error }],
      };
    }
    save();
  }
  if (failure) {
    throw Object.assign(failure, { receipt });
  }
  return receipt;
}
