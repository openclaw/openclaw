// Genuine fork-point T -> tested merge T+1 -> resident rollback -> genuine T.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createReaderFixture,
  runReaderCommand,
  smokeRunningReaderFixture,
} from "./reader-fixture.mjs";
import { killFixtureProcessGroup, startNodeFixture } from "./release-process.mjs";
import { inspectFixtureStores } from "./schema-store-facts.mjs";

const barrierPath = fileURLToPath(new URL("./schema-downgrade-barrier.mjs", import.meta.url));
const positiveVersion = (value) => Number.isSafeInteger(value) && value > 0;
const errorText = (error) => String(error?.message ?? error).slice(-4096);
const fileSha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The controller and its receipt consumer classify the same observed store facts.
/**
 * @param {{
 *   before: ReturnType<typeof inspectFixtureStores>,
 *   after: ReturnType<typeof inspectFixtureStores>,
 *   rolledBack?: ReturnType<typeof inspectFixtureStores>,
 *   schemaVersions: { state: number, agent: number },
 *   smoke?: {
 *     status: string,
 *     failureKind?: "setup" | "compatibility",
 *     failure?: { message: string, command?: unknown },
 *     gateway?: { error?: string },
 *   } | null,
 * }} params
 */
export function classifySchemaDowngrade({
  before,
  after,
  rolledBack,
  schemaVersions,
  smoke = null,
}) {
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
    // A newly created store has a null preimage; the resident owns its removal.
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
  if (rolledBack) {
    const final = new Map(rolledBack.map((store) => [store.relativePath, store]));
    if (final.size !== rolledBack.length) {
      fail(null, "Duplicate physical store paths after resident rollback");
    }
    for (const store of stores) {
      const prior = previous.get(store.relativePath);
      if (!prior) {
        continue;
      }
      const restored = final.get(store.relativePath);
      const expected = store.raised ? prior : current.get(store.relativePath);
      if (
        !restored ||
        restored.role !== expected.role ||
        restored.version !== expected.version ||
        restored.minReader !== expected.minReader ||
        restored.integrity !== "ok"
      ) {
        fail(
          store.relativePath,
          store.raised
            ? "Resident did not restore the raised-floor store to T's committed schema/floor"
            : "Resident did not retain T+1's unraised store schema/floor",
        );
      }
    }
  }
  if (smoke?.failureKind === "setup" || smoke?.gateway?.error) {
    fail(null, smoke.failure?.message ?? smoke.gateway?.error ?? "T reader setup failed");
  } else if (smoke && smoke.status !== "passed") {
    // The real resident has already rolled back. No T refusal can excuse a
    // store that should have been restored or an incompatible additive step.
    compatibilityFailures.push({
      message: smoke.failure?.message ?? "T reader smoke did not pass",
    });
  }
  const failed = structuralFailures.length > 0 || compatibilityFailures.length > 0;
  const result = failed ? "failed" : !smoke || !rolledBack ? "pending" : "passed";
  return {
    mode: "enforced",
    result,
    stores,
    structuralFailures,
    compatibilityFailures,
    gate: {
      enforced: true,
      passed: result === "passed",
      result,
      failures: [...structuralFailures, ...compatibilityFailures],
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

async function waitForBarrier(resident, sentinel, port, readTrial, deadline) {
  while (Date.now() < deadline) {
    try {
      const mark = JSON.parse(fs.readFileSync(sentinel, "utf8"));
      assert.equal(mark.port, port, "Candidate barrier intercepted the wrong port");
      assert(Number.isSafeInteger(mark.pid) && mark.pid > 0, "Invalid candidate barrier PID");
      return mark;
    } catch (error) {
      // The small sentinel can be observed between creation and write completion.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (readTrial().phase === "rolled-back") {
      return null;
    }
    if (resident.error()) {
      throw resident.error();
    }
    if (resident.child.exitCode !== null || resident.child.signalCode !== null) {
      throw new Error(
        `Resident exited before rollback/listen barrier: ${JSON.stringify(await resident.exited)}`,
      );
    }
    await delay(50);
  }
  throw new Error("Resident did not reach candidate listen or rollback within 300 seconds");
}

export async function runSchemaDowngrade({
  previousRoot,
  previousPrefix,
  candidateTarball,
  previousBuild,
  candidateBuild,
  npmCache,
  root,
  artifacts,
  env,
}) {
  fs.mkdirSync(artifacts, { recursive: true });
  const receipt = {
    scope: "genuine-previous-reader-resident-rollback",
    result: "setup-failed",
    mode: "enforced",
    expectedBuilds: {
      previous: { ...previousBuild, root: previousRoot },
      candidate: { ...candidateBuild, tarball: candidateTarball },
    },
    fixture: null,
    config: null,
    before: [],
    after: [],
    rolledBack: null,
    attempts: [],
    launcher: null,
    smoke: null,
    gate: { enforced: true, passed: false, result: "setup-failed", failures: [] },
  };
  let resident;
  let candidatePid;
  /** @type {Error | undefined} */
  let failure;
  const save = () => {
    const log = [
      receipt.setupFailure?.gateway?.output,
      ...receipt.attempts.map((attempt) => attempt.outputTail),
      receipt.resident?.outputTail,
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
    receipt.previousBuild = readBuild(previousRoot, previousBuild);
    assert.notEqual(
      previousBuild.commit,
      candidateBuild.commit,
      "T and T+1 must be genuine different commits",
    );
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
    // These are inspection copies, never recovery preimages.
    receipt.before = inspectFixtureStores(
      fixture.stateDir,
      path.join(artifacts, "schema-downgrade-baseline"),
    );
    receipt.config = {
      path: fixture.configPath,
      beforeSha256: fileSha256(fixture.configPath),
      afterCandidateSha256: null,
      afterRollbackSha256: null,
    };
    fs.writeFileSync(
      path.join(fixture.home, ".npmrc"),
      `prefix=${previousPrefix}\ncache=${npmCache ?? path.join(root, "npm-cache")}\n`,
    );
    fixture.env.PATH = `${path.join(previousPrefix, "bin")}${path.delimiter}${fixture.env.PATH ?? ""}`;
    try {
      receipt.preparation = await runReaderCommand(
        fixture,
        previousRoot,
        [
          "update",
          "--tag",
          `file:${path.resolve(candidateTarball)}`,
          "--no-restart",
          "--yes",
          "--json",
        ],
        600_000,
      );
    } catch (error) {
      throw new Error(
        "T's updater could not prepare the candidate; rebase a stale fork point before retrying.",
        { cause: error },
      );
    }
    const launcher = fs.readFileSync(path.join(previousRoot, ".openclaw-launcher"), "utf8").trim();
    const prefix = path.dirname(launcher);
    const trialFile = path.join(prefix, "releases", ".trial");
    const readTrial = () => JSON.parse(fs.readFileSync(trialFile, "utf8"));
    const prepared = readTrial();
    assert.equal(prepared.phase, "pending", "Public update did not prepare a pending trial");
    assert.equal(
      fs.realpathSync(path.resolve(prefix, prepared.previous)),
      fs.realpathSync(previousRoot),
      "Prepared trial does not retain genuine T",
    );
    const candidateRoot = fs.realpathSync(path.resolve(prefix, prepared.target));
    assert.notEqual(
      candidateRoot,
      fs.realpathSync(previousRoot),
      "T+1 must be a distinct built root",
    );
    receipt.candidateBuild = readBuild(candidateRoot, candidateBuild);
    const manifest = JSON.parse(fs.readFileSync(path.join(candidateRoot, "package.json"), "utf8"));
    assert.equal(
      manifest.version,
      candidateBuild.version,
      "Candidate manifest/build version mismatch",
    );
    const schemaVersions = manifest.openclaw?.schemaVersions;
    assert(schemaVersions, "Candidate package is missing schema targets");
    receipt.schemaVersions = schemaVersions;
    const restoreManifestPath = path.join(
      path.dirname(path.resolve(prefix, prepared.target)),
      ".restore",
    );
    receipt.launcher = {
      path: launcher,
      format:
        Number(
          fs.readFileSync(launcher, "utf8").match(/^\/\/ OpenClaw launcher format: (\d+)$/m)?.[1],
        ) || null,
      trialFile,
      prepared,
      restoreManifestPath,
      restoreManifest: null,
    };
    const sentinel = path.join(root, "candidate-prelisten.json");
    const args = [launcher, "gateway", "run", "--port", String(fixture.port)];
    const residentEnv = {
      ...fixture.env,
      OPENCLAW_SCHEMA_DOWNGRADE_PORT: String(fixture.port),
      OPENCLAW_SCHEMA_DOWNGRADE_SENTINEL: sentinel,
      OPENCLAW_SCHEMA_DOWNGRADE_TARGET: candidateRoot,
      NODE_OPTIONS: [fixture.env.NODE_OPTIONS, `--import=${JSON.stringify(barrierPath)}`]
        .filter(Boolean)
        .join(" "),
    };
    receipt.launcher.invocation = { executable: process.execPath, args, barrierPath };
    save();
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      fs.rmSync(sentinel, { force: true });
      // Invoke the actual resident, not T's shim: RPC clients deliberately pin forwarding.
      resident = startNodeFixture(args, residentEnv);
      const mark = await waitForBarrier(resident, sentinel, fixture.port, readTrial, deadline);
      if (!mark) {
        break;
      }
      candidatePid = mark.pid;
      const attempt = { barrier: mark, trial: readTrial(), exit: null, outputTail: "" };
      receipt.attempts.push(attempt);
      assert.equal(attempt.trial.phase, "trial", "Candidate reached listen outside its real trial");
      // Resident restart mid-trial: stop the supervisor first so it cannot race the
      // quiescent store observation by restarting a separately detached candidate.
      killFixtureProcessGroup(resident.child.pid, "SIGKILL");
      await resident.exited;
      killFixtureProcessGroup(candidatePid, "SIGKILL");
      candidatePid = undefined;
      attempt.exit = await resident.stop("SIGKILL");
      attempt.outputTail = resident.output();
      resident = undefined;
      receipt.after = inspectFixtureStores(
        fixture.stateDir,
        path.join(artifacts, `schema-downgrade-post-candidate-${receipt.attempts.length}`),
      );
      receipt.config.afterCandidateSha256 = fileSha256(fixture.configPath);
      if (fs.existsSync(restoreManifestPath)) {
        receipt.launcher.restoreManifest = JSON.parse(fs.readFileSync(restoreManifestPath, "utf8"));
      }
      Object.assign(
        receipt,
        classifySchemaDowngrade({
          before: receipt.before,
          after: receipt.after,
          schemaVersions,
        }),
      );
      save();
      assert.equal(
        receipt.structuralFailures.length,
        0,
        "Candidate committed schema/target verification failed",
      );
      // Leave attempts, timestamps, slot and trial untouched. The real resident's
      // next start decides whether to retry or roll back.
    }
    assert(
      resident && receipt.attempts.length > 0,
      "No genuine candidate pre-ready crash was observed",
    );
    receipt.launcher.rolledBack = readTrial();
    assert.equal(
      receipt.launcher.rolledBack.phase,
      "rolled-back",
      "Resident did not roll back the trial",
    );
    receipt.launcher.selectedRoot = fs.realpathSync(path.join(prefix, "openclaw"));
    assert.equal(
      receipt.launcher.selectedRoot,
      fs.realpathSync(previousRoot),
      "Resident did not select T",
    );
    try {
      receipt.smoke = await smokeRunningReaderFixture(previousRoot, fixture, resident);
    } catch (error) {
      if (!error.receipt) {
        throw error;
      }
      receipt.smoke = error.receipt;
    }
    const exit = await resident.stop("SIGTERM", 17_000);
    receipt.resident = { exit, outputTail: resident.output() };
    resident = undefined;
    receipt.rolledBack = inspectFixtureStores(
      fixture.stateDir,
      path.join(artifacts, "schema-downgrade-post-rollback"),
    );
    receipt.config.afterRollbackSha256 = fileSha256(fixture.configPath);
    Object.assign(
      receipt,
      classifySchemaDowngrade({
        before: receipt.before,
        after: receipt.after,
        rolledBack: receipt.rolledBack,
        schemaVersions,
        smoke: receipt.smoke,
      }),
    );
    if (!receipt.gate.passed) {
      failure = new Error("Required schema downgrade gate failed; see schema-downgrade.json");
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(errorText(error), { cause: error });
    receipt.error = errorText(error);
    if (error?.receipt) {
      receipt.setupFailure = error.receipt;
    }
    if (error?.cause?.command) {
      receipt.preparationFailure = error.cause.command;
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
      if (candidatePid) {
        killFixtureProcessGroup(candidatePid, "SIGKILL");
      }
      if (resident) {
        const exit = await resident.stop("SIGTERM", 17_000);
        receipt.resident = { exit, outputTail: resident.output() };
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
