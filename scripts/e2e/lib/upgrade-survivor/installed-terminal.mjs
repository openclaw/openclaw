#!/usr/bin/env node
// Real installed CLI proof; synthetic state and an external launcher-identity fault.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { hasUnjoinedWork, runManagedCommand } from "../../../lib/managed-child-process.mts";
import { packFirstHopUpdateFixture } from "../update-first-hop-package-fixtures.mjs";
import {
  fileDigest,
  installedRecoveryEvidenceMode,
  openInstalledRecoveryEvidence,
  readActivation,
  writeInstalledRecoveryEvidence,
} from "./installed-recovery-observations.mjs";
import {
  assertInstalledTerminalApplication,
  readInstalledTerminalMetadata,
  readInstalledTerminalReference,
} from "./installed-terminal-contracts.mjs";
import { installedTerminalNpmOwner } from "./installed-terminal-dependencies.mjs";
import {
  assertInstalledTerminalOutput,
  buildInstalledTerminalSummary,
  captureInstalledTerminalProcessAbsence,
  installedTerminalDescendants,
  readInstalledTerminalClosedEntries,
  publishInstalledTerminalEvidence,
  readInstalledTerminalEvents,
  readInstalledTerminalHasher,
  readInstalledTerminalHeartbeat,
  restoreInstalledTerminalLauncher,
  summarizeInstalledTerminalLaunches,
} from "./installed-terminal-observer.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const diagnostic = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: bytes.length > 16 * 1024,
    text:
      bytes.length <= 16 * 1024
        ? bytes.toString()
        : `${bytes.subarray(0, 8 * 1024).toString()}\n[... bounded diagnostic excerpt ...]\n${bytes.subarray(-8 * 1024).toString()}`,
  };
};

async function main() {
  const [packageArg, artifactsArg, contractsArg] = process.argv.slice(2);
  assert.equal(process.platform, "linux");
  assert.equal(
    process.version,
    "v24.22.1",
    "Observer contract is pinned to the bare runner Node version",
  );
  assert(fs.existsSync("/.dockerenv"), "Use the bare Docker E2E runner");
  assert(packageArg && artifactsArg && contractsArg);
  const sourcePackage = fs.realpathSync(packageArg);
  const artifacts = fs.realpathSync(artifactsArg);
  const readContract = (file) => {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, stat.size);
    return JSON.parse(bytes);
  };
  const prepared = readContract(contractsArg);
  assert.equal(prepared.packageSha256, fileDigest(sourcePackage));
  for (const role of ["current", "historical"]) {
    const reference = readInstalledTerminalReference(role, prepared.references[role].encoded);
    assert.equal(reference.policy.legacyPeerDeps, false);
  }
  // The pinned bare image owns Node and this adjacent npm launcher. Use that
  // exact CLI for installation and its bundled Arborist/pacote for attestation.
  const imageBin = path.dirname(fs.realpathSync(process.execPath));
  const npm = installedTerminalNpmOwner(path.join(imageBin, "npm"));
  assert.equal(npm.cli, path.resolve(imageBin, "../lib/node_modules/npm/bin/npm-cli.js"));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-installed-terminal-"));
  const deadline = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS) * 1000;
  assert(Number.isSafeInteger(deadline) && deadline > Date.now());
  const maxOutput = 8 * 1024 * 1024;
  const publishedIntegrity =
    "sha512-KbIl0/7an0/nKBo92FnJg7LFcEpFVQyOgSRfHNE9yxELg1Ebql7BmBsdLL+1dDOLZnQtuwjt6Hy45CCrmYdJNA==";
  const schemaFile = fileURLToPath(
    new URL("../../../../test/fixtures/sqlite/openclaw-agent-schema-v25.sql", import.meta.url),
  );
  const schema = fs.readFileSync(schemaFile, "utf8");
  assert.equal(
    createHash("sha256").update(schema).digest("hex"),
    "287a109afc7b49a9f6cb9d9789674d143d7ce78bbef8d3ef0dce8c8723ec8470",
  );
  const summary = {
    status: "running",
    scope: "installed-terminal-package-settlement",
    sourcePackageSha256: fileDigest(sourcePackage),
    commands: [],
    cells: [],
    npm,
  };
  const write = (name, value) => writeInstalledRecoveryEvidence(path.join(artifacts, name), value);
  const save = () => write("installed-terminal.json", summary);

  let unjoined = false;
  save();

  async function run(
    name,
    bin,
    args,
    env,
    { expected = [0], cleanup = false, cwd = runtime } = {},
  ) {
    assert.match(name, /^[a-z0-9-]+$/u);
    const cap = deadline - Date.now() - (cleanup ? 10_000 : 90_000);
    assert(cap > 0, "Installed terminal proof exhausted its absolute deadline");
    const receipt = { name, bin, args, status: "running", startedAt: Date.now() };
    summary.commands.push(receipt);
    save();
    console.log(`[installed-terminal] ${name}`);
    const buffers = [[], []];
    const sizes = [0, 0];
    const outputFds = ["out", "err"].map((suffix) =>
      openInstalledRecoveryEvidence(path.join(artifacts, `${name}.${suffix}`)),
    );
    const controller = new AbortController();
    let outputError;
    let result;
    try {
      result = await runManagedCommand({
        bin,
        args,
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: Math.min(cap, cleanup ? 60_000 : 900_000),
        timeoutKillGraceMs: 5_000,
        signalKillGraceMs: 5_000,
        abortKillGraceMs: 5_000,
        cleanupDrainTimeoutMs: 5_000,
        requireProcessTreeExit: true,
        timeoutForceKillOnLeaderExit: true,
        signal: controller.signal,
        onReady(child) {
          receipt.pid = child.pid;
          child.once("exit", (code, signal) => {
            receipt.exit = { code, signal };
          });
          for (const [index, stream] of [child.stdout, child.stderr].entries()) {
            assert(stream);
            stream.on("data", (chunk) => {
              try {
                sizes[index] += chunk.length;
                assert(sizes[index] <= maxOutput, `${name}: output budget exceeded`);
                fs.writeSync(outputFds[index], chunk);
                buffers[index].push(Buffer.from(chunk));
              } catch (error) {
                outputError ??= error;
                controller.abort(error);
              }
            });
          }
        },
      });
      assert(!outputError, String(outputError));
      assert.deepEqual(receipt.exit, { code: result, signal: null });
      receipt.status = "completed";
      receipt.exitCode = result;
      receipt.treeJoined = true;
    } catch (error) {
      unjoined ||= hasUnjoinedWork(error);
      receipt.status = "failed";
      receipt.error = String(error);
      receipt.treeJoined = !hasUnjoinedWork(error);
      throw error;
    } finally {
      outputFds.forEach((fd) => fs.closeSync(fd));
      receipt.elapsedMs = Date.now() - receipt.startedAt;
      receipt.outputBytes = sizes;
      receipt.outputSha256 = buffers.map((chunks) =>
        createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
      );
      receipt.capturedOutputBytes = buffers.map((chunks) =>
        chunks.reduce((size, chunk) => size + chunk.length, 0),
      );
      receipt.outputComplete =
        receipt.status === "completed" &&
        !outputError &&
        sizes.every((size, index) => size === receipt.capturedOutputBytes[index]);
      save();
      console.error(`[installed-terminal] command-outcome ${JSON.stringify(receipt)}`);
      if (
        receipt.status !== "completed" ||
        name.endsWith("-update") ||
        (expected !== null && !expected.includes(result))
      ) {
        for (const [index, stream] of ["stdout", "stderr"].entries()) {
          console.error(
            `[installed-terminal] ${name} ${stream} ${JSON.stringify(diagnostic(Buffer.concat(buffers[index])))}`,
          );
        }
      }
    }
    assert(expected === null || expected.includes(result), `${name}: unexpected exit ${result}`);
    return {
      pid: receipt.pid,
      code: result,
      stdout: Buffer.concat(buffers[0]).toString(),
      stderr: Buffer.concat(buffers[1]).toString(),
    };
  }

  function readDatabase(filename, read) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }
  const only = (rows, event) => {
    const matches = rows.filter((row) => row.event === event);
    assert.equal(matches.length, 1, `Expected one ${event}`);
    return matches[0];
  };

  function validateObservation(rows, spec, result) {
    const handoff = only(rows, "handoff");
    const success = only(rows, "candidate-success");
    const closed = only(rows, "worker-closed");
    assert.equal(success.pid, handoff.pid);
    assert.equal(success.child, handoff.child);
    assert.equal(closed.child, handoff.child);
    assert(BigInt(closed.time) < BigInt(success.time));
    assert.equal(closed.code, 0);
    assert.equal(closed.signal, null);
    assert(closed.stdoutEnded && closed.stderrEnded);
    const startups = rows.filter((row) => row.event === "startup");
    assert(startups.some((row) => row.pid === handoff.child));
    assert(
      startups.some((row) => row.pid === result.pid && row.thread === 0),
      "Missing initial CLI preload",
    );
    // The launcher can respawn before activation. Follow the actual process tree,
    // excluding only the observed candidate subtree, never just one convenient PID.
    const all = installedTerminalDescendants(rows, result.pid);
    const candidateProcesses = installedTerminalDescendants(rows, handoff.child);
    assert(all.has(handoff.pid) && all.has(handoff.child));
    assert(
      startups.every((row) => all.has(row.pid)),
      "Unattributed observer process",
    );
    const predecessor = (row) => all.has(row.pid) && !candidateProcesses.has(row.pid);
    const lateOpens = rows.filter(
      (row) =>
        predecessor(row) &&
        BigInt(row.time) >= BigInt(handoff.time) &&
        row.event.startsWith("sqlite-") &&
        row.event !== "sqlite-intent",
    );
    const canonicalStores = handoff.databases;
    assert(canonicalStores.some((entry) => entry.location === spec.stateDatabase));
    assert(canonicalStores.some((entry) => entry.location === spec.agentDatabase));
    const canonicalStateAccess = [];
    for (const row of lateOpens) {
      if (row.opened === false) {
        continue;
      }
      assert.notEqual(row.location, "unknown");
      if (
        canonicalStores.some(
          (entry) =>
            entry.canonical === row.canonical ||
            (entry.identity !== null &&
              entry.identity !== undefined &&
              entry.identity === row.identity),
        )
      ) {
        canonicalStateAccess.push(row);
      }
    }
    // Historical failure triage may reopen state too. Preserve that evidence,
    // but require the selected early-publication defect and exact late refusal.
    if (!spec.historical) {
      assert.equal(
        canonicalStateAccess.length,
        0,
        "Predecessor opened or attempted to open canonical migrated state",
      );
    }
    const after = readDatabase(spec.stateDatabase, (db) => ({
      ...db
        .prepare("SELECT * FROM update_runs WHERE run_id = ?")
        .get(success.response.terminalRunId),
    }));
    assert.deepEqual(
      after,
      success.candidate,
      "Parent changed the candidate's committed terminal row",
    );
    assertInstalledTerminalOutput(rows, spec, result);
    return {
      runId: success.response.terminalRunId,
      parentPid: handoff.pid,
      workerPid: handoff.child,
      before: handoff.request.params.schemaVersions,
      candidate: success.candidate,
      agent: success.agent,
      predecessorLateOpens: lateOpens,
      canonicalStateAccess,
      zeroReopenRequired: !spec.historical,
      historicalEarlyPublication: spec.historical === true,
      ...summarizeInstalledTerminalLaunches(rows),
      processAbsence: spec.processAbsence,
    };
  }

  async function cell(name, baseline, historical, fault) {
    const record = {
      name,
      historical,
      fault,
      status: "running",
      cleanup: { status: "not-started" },
    };
    summary.cells.push(record);
    save();
    const directory = path.join(runtime, name);
    const evidence = path.join(artifacts, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(evidence, { mode: installedRecoveryEvidenceMode(artifacts, true) });
    fs.chmodSync(evidence, installedRecoveryEvidenceMode(artifacts, true));
    const prefix = path.join(directory, "npm");
    const state = path.join(directory, "state");
    const home = path.join(directory, "home");
    const tmp = path.join(directory, "tmp");
    for (const file of [prefix, state, home, tmp]) {
      fs.mkdirSync(file);
    }
    const env = {
      PATH: `${prefix}/bin:${process.env.PATH}`,
      HOME: home,
      OPENCLAW_HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      STATE_DIRECTORY: state,
      NODE_COMPILE_CACHE: path.join(tmp, "compile-cache"),
      CI: "true",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_NO_PROMPT: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
      npm_config_prefix: prefix,
      npm_config_cache: path.join(runtime, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const root = path.join(prefix, "lib/node_modules/openclaw");
    const bin = path.join(prefix, "bin/openclaw");
    const node = fs.realpathSync(process.execPath);
    const command = (phase, args, options) =>
      run(`${name}-${phase}`, node, [bin, ...args], env, options);
    await run(
      `${name}-install`,
      node,
      [npm.cli, "install", "--global", "--prefix", prefix, baseline, "--no-fund", "--no-audit"],
      env,
    );
    const baselineManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    assert.equal(baselineManifest.openclaw.schemaVersions.state, historical ? 20 : 39);
    const baselineIdentity = readWorkerCellPackageIdentity(root);
    assertWorkerCellPackageIdentity(
      baselineIdentity,
      historical ? publishedIdentity : sourceIdentity,
    );
    record.baselineMetadata = readInstalledTerminalMetadata(root, baselineIdentity);
    save();
    const baselineHeartbeat = historical
      ? heartbeatPackages["published-identity"]
      : heartbeatPackages["source-identity"];
    const role = historical ? "historical" : "current";
    const referenceFile = path.join(directory, "dependency-reference.json");
    const encodedReference = prepared.references[role].encoded;
    fs.writeFileSync(referenceFile, encodedReference, { flag: "wx", mode: 0o600 });
    const dependencyReceipt = path.join(evidence, "dependencies.json");
    assert.deepEqual(installedTerminalNpmOwner(npm.cli), npm);
    await run(
      `${name}-dependencies`,
      node,
      [
        fileURLToPath(new URL("./installed-terminal-dependencies.mjs", import.meta.url)),
        root,
        npm.cli,
        env.npm_config_cache,
        path.join(directory, "dependency-attestation"),
        referenceFile,
        dependencyReceipt,
      ],
      env,
    );
    const dependencies = readContract(dependencyReceipt);
    assert.deepEqual(dependencies.npm, npm);
    baselineHeartbeat.dependencies = dependencies.tree;
    baselineHeartbeat.dependencyReferenceSha256 = createHash("sha256")
      .update(encodedReference)
      .digest("hex");
    record.dependencyReferenceSha256 = baselineHeartbeat.dependencyReferenceSha256;
    record.dependencyTree = dependencies.tree;
    if (!historical) {
      candidateHeartbeat.dependencies = dependencies.tree;
      candidateHeartbeat.dependencyReferenceSha256 = baselineHeartbeat.dependencyReferenceSha256;
    }
    assert(candidateHeartbeat.dependencies, "Current baseline must qualify before RED");
    write(`${name}-dependencies.json`, dependencies);
    write("package-heartbeat-contracts.json", {
      packages: heartbeatPackages,
      entries: heartbeatEntries,
    });
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: { enabled: false },
        agents: { entries: { main: { workspace: path.join(directory, "workspace") } } },
      }),
    );
    await command("initialize", ["doctor", "--fix", "--non-interactive"], { expected: [0, 1] });
    const stateDatabase = path.join(state, "state/openclaw.sqlite");
    assert.equal(
      readDatabase(
        stateDatabase,
        (db) =>
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
            .schema_version,
      ),
      baselineManifest.openclaw.schemaVersions.state,
    );
    const config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH));
    config.agents.entries.terminal = { workspace: path.join(directory, "terminal-workspace") };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    const agentDatabase = path.join(state, "agents/terminal/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentDatabase), { recursive: true });
    assert(!fs.existsSync(agentDatabase));
    const agent = new DatabaseSync(agentDatabase);
    try {
      agent.exec(schema);
      agent.exec("PRAGMA user_version = 25");
      agent
        .prepare(
          "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at) VALUES ('primary', 'agent', 25, 'terminal', 1, 1)",
        )
        .run();
      agent
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('installed-terminal', 'retained', '\"preserve-me\"', 1)",
        )
        .run();
    } finally {
      agent.close();
    }
    const anchor = path.join(
      path.dirname(root),
      `.openclaw.package-activation-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    );
    const helper = path.join(`${anchor}.control`, "recovery.mjs");
    const journal = path.join(`${anchor}.control`, "operation.sqlite");
    const spec = {
      directory: evidence,
      root,
      bin,
      stateDatabase,
      agentDatabase,
      journal,
      historical,
      fault,
      agentVersion: 41,
      escrow: path.join(directory, "launcher-original"),
      hashWorker: {
        path: path.join(root, "dist/infra/package-update-integrity-hasher.worker.js"),
        sha256: candidateHasher.sha256,
      },
      heartbeatWorkers: [candidateHeartbeat, baselineHeartbeat],
      compileCacheBase: env.NODE_COMPILE_CACHE,
    };
    const specPath = path.join(evidence, "observer.json");
    writeInstalledRecoveryEvidence(specPath, spec);
    const observer = fileURLToPath(new URL("./installed-terminal-observer.mjs", import.meta.url));
    let result;
    try {
      result = await run(
        `${name}-update`,
        node,
        [bin, "update", "--tag", `file:${candidate}`, "--yes", "--no-restart", "--json"],
        {
          ...env,
          OPENCLAW_INSTALLED_TERMINAL_OBSERVER: specPath,
          NODE_OPTIONS: `--import=${observer}`,
        },
        { expected: null },
      );
    } catch (error) {
      record.cleanup = {
        status: "held",
        reason: "Updater did not return a natural joined command result",
      };
      save();
      throw error;
    }
    let verdict;
    /** @type {Error | undefined} */
    let validationError;
    try {
      const observationSpec = {
        ...spec,
        processAbsence: captureInstalledTerminalProcessAbsence(evidence),
      };
      writeInstalledRecoveryEvidence(specPath, observationSpec);
      verdict = validateObservation(
        readInstalledTerminalEvents(evidence, observationSpec),
        observationSpec,
        result,
      );
      assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), candidateIdentity);
    } catch (error) {
      validationError =
        error instanceof Error
          ? error
          : new Error("Installed terminal observation failed", { cause: error });
    }
    // Custody does not depend on parsing the event stream or a passing oracle.
    // Only the exact independent intent/replacement receipts authorize restoration.
    try {
      const restored = restoreInstalledTerminalLauncher(spec);
      record.cleanup = { status: "restored", launcher: restored.status, joined: true };
      save();
      if (restored.row) {
        assert.deepEqual(readActivation(journal), restored.row);
        const descriptor = JSON.parse(restored.row.descriptor_json);
        const retired = await run(
          `${name}-retire`,
          node,
          [helper, "--anchor", anchor, "--operation", descriptor.operationId, "retire"],
          env,
          { cleanup: true },
        );
        assert.deepEqual(JSON.parse(retired.stdout), {
          phase: "complete",
          operationId: descriptor.operationId,
          installKey: root,
        });
      }
      const completed = readActivation(journal);
      assert.equal(completed.phase, "anchor-retired");
      assert(!fs.existsSync(anchor) && !fs.existsSync(helper));
      const authority = JSON.parse(completed.descriptor_json).authority;
      const leases = readDatabase(authority.databasePath, (db) =>
        db.prepare("SELECT * FROM managed_update_handoffs").all(),
      );
      assert.equal(
        leases.filter(
          (row) =>
            row.install_root === root ||
            row.install_root.startsWith(`${root}/.openclaw-update-child-`),
        ).length,
        0,
      );
      record.cleanup = {
        status: "complete",
        launcher: restored.status,
        joined: true,
        phase: completed.phase,
        activeInstallLeases: 0,
        journalRetained: true,
      };
      save();
    } catch (error) {
      record.cleanup = { ...record.cleanup, status: "held", error: String(error) };
      record.oracleError = validationError && String(validationError);
      save();
      throw error;
    }
    if (validationError) {
      record.status = "failed";
      record.oracleError = String(validationError);
      save();
      throw validationError;
    }
    Object.assign(record, {
      status: "passed",
      ...verdict,
      installedIdentity: {
        version: candidateIdentity.version,
        buildInfo: candidateIdentity.buildInfo,
        files: Object.keys(candidateIdentity.files).length,
      },
    });
    save();
  }

  let candidate;
  let candidateIdentity;
  let candidateHasher;
  let candidateHeartbeat;
  let sourceIdentity;
  let publishedIdentity;
  const heartbeatPackages = {};
  const heartbeatEntries = {};
  const retainHeartbeat = (name, tarball, root, identity) => {
    const { source, ...contract } = readInstalledTerminalHeartbeat(root, identity);
    const closedEntries = readInstalledTerminalClosedEntries(
      root,
      identity,
      name === "published-identity",
    );
    const application =
      name === "published-identity"
        ? { sourceCommit: identity.buildInfo.commit }
        : assertInstalledTerminalApplication(identity, prepared.application);
    for (const entry of [{ ...contract, source }, ...closedEntries]) {
      heartbeatEntries[entry.sha256] ??= {
        bytes: Buffer.byteLength(entry.source),
        encoding: "gzip+base64",
        data: gzipSync(entry.source).toString("base64"),
      };
    }
    const bytes = Buffer.from(JSON.stringify(identity));
    assert(bytes.length <= 4 * 1024 * 1024);
    const inventoryPath = path.join(runtime, `${name}-inventory.json`);
    fs.writeFileSync(inventoryPath, bytes, { flag: "wx", mode: 0o600 });
    heartbeatPackages[name] = {
      tarballSha256: fileDigest(tarball),
      ...contract,
      application,
      closedEntries: closedEntries.map(({ source: _source, ...entry }) => entry),
      inventory: { path: inventoryPath, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
    // Bundled heartbeat entries are large. Retain full bytes once per digest;
    // process preloads receive only the small identity and inventory reference.
    const evidence = { packages: heartbeatPackages, entries: heartbeatEntries };
    assert(Buffer.byteLength(`${JSON.stringify(evidence, null, 2)}\n`) <= 4 * 1024 * 1024);
    write("package-heartbeat-contracts.json", evidence);
    return heartbeatPackages[name];
  };
  async function inspectBaseline(name, tarball, commit) {
    const directory = path.join(runtime, name);
    fs.mkdirSync(directory);
    try {
      await run(
        name,
        "tar",
        [
          "-xzf",
          tarball,
          "-C",
          directory,
          "package/package.json",
          "package/openclaw.mjs",
          "package/dist",
        ],
        { PATH: process.env.PATH },
      );
      const identity = readWorkerCellPackageIdentity(path.join(directory, "package"));
      assert.equal(identity.buildInfo.commit, commit);
      retainHeartbeat(name, tarball, path.join(directory, "package"), identity);
      return identity;
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  }
  try {
    candidate = path.join(runtime, "candidate.tgz");
    summary.fixture = packFirstHopUpdateFixture(sourcePackage, candidate, 1);
    summary.candidateSha256 = fileDigest(candidate);
    const unpacked = path.join(runtime, "identity");
    fs.mkdirSync(unpacked);
    await run(
      "candidate-identity",
      "tar",
      [
        "-xzf",
        candidate,
        "-C",
        unpacked,
        "package/package.json",
        "package/openclaw.mjs",
        "package/dist",
      ],
      { PATH: process.env.PATH },
    );
    candidateIdentity = readWorkerCellPackageIdentity(path.join(unpacked, "package"));
    assert.equal(candidateIdentity.buildInfo.commit, process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA);
    write("candidate-package-identity.json", candidateIdentity);
    candidateHasher = readInstalledTerminalHasher(
      path.join(unpacked, "package"),
      candidateIdentity,
      (contract) => write("package-hasher-contract.json", contract),
    );
    candidateHeartbeat = retainHeartbeat(
      "candidate",
      candidate,
      path.join(unpacked, "package"),
      candidateIdentity,
    );
    fs.rmSync(unpacked, { recursive: true });
    sourceIdentity = await inspectBaseline(
      "source-identity",
      sourcePackage,
      candidateIdentity.buildInfo.commit,
    );
    assert.equal(
      createHash("sha256").update(JSON.stringify(sourceIdentity.files)).digest("hex"),
      prepared.inventorySha256,
    );
    const fetchEnv = {
      PATH: process.env.PATH,
      HOME: path.join(runtime, "fetch-home"),
      npm_config_cache: path.join(runtime, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    fs.mkdirSync(fetchEnv.HOME);
    const packed = await run(
      "published-control-pack",
      process.execPath,
      [npm.cli, "pack", "openclaw@2026.10.9", "--json", "--pack-destination", runtime],
      fetchEnv,
    );
    const [metadata] = JSON.parse(packed.stdout);
    assert.equal(metadata.name, "openclaw");
    assert.equal(metadata.version, "2026.10.9");
    assert.equal(metadata.integrity, publishedIntegrity);
    assert.equal(path.basename(metadata.filename), metadata.filename);
    const historical = path.join(runtime, metadata.filename);
    assert.equal(
      `sha512-${createHash("sha512").update(fs.readFileSync(historical)).digest("base64")}`,
      publishedIntegrity,
    );
    summary.historical = {
      version: metadata.version,
      integrity: publishedIntegrity,
      sha256: fileDigest(historical),
    };
    publishedIdentity = await inspectBaseline(
      "published-identity",
      historical,
      "8b18b5578f66eab1501cba4cef2310d88bfb9a41",
    );
    save();
    await cell("healthy", sourcePackage, false, false);
    await cell("late-failure", sourcePackage, false, true);
    await cell("historical-control", historical, true, true);
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = String(error);
    console.error(
      `[installed-terminal] driver-error ${JSON.stringify(diagnostic(error instanceof Error ? error.stack : error))}`,
    );
    process.exitCode = 1;
  } finally {
    summary.unjoined = unjoined;
    summary.runtime = runtime;
    if (summary.status === "passed" && !unjoined) {
      fs.rmSync(runtime, { recursive: true });
      summary.runtimeRemoved = true;
    }
    save();
    try {
      assert(!unjoined, "Evidence export refused while producer custody is unknown");
      publishInstalledTerminalEvidence(artifacts, summary);
    } catch (error) {
      summary.status = "failed";
      summary.evidenceError = String(error);
      process.exitCode = 1;
      console.error(`[installed-terminal] evidence-error ${JSON.stringify(diagnostic(error))}`);
      save();
    }
    const exportedSummary = path.join(artifacts, "export/installed-terminal.json");
    try {
      if (fs.existsSync(path.dirname(exportedSummary))) {
        const exportDirectory = path.dirname(exportedSummary);
        const exported = buildInstalledTerminalSummary(
          summary,
          fs.readFileSync(path.join(exportDirectory, "manifest.json")),
          (name) => fs.readFileSync(path.join(exportDirectory, name)),
        );
        writeInstalledRecoveryEvidence(exportedSummary, exported);
      }
    } catch (error) {
      summary.status = "failed";
      summary.evidenceError = String(error);
      process.exitCode = 1;
      console.error(
        `[installed-terminal] summary-export-error ${JSON.stringify(diagnostic(error))}`,
      );
    }
    console.error(
      `[installed-terminal] outcome ${JSON.stringify(
        diagnostic(
          JSON.stringify({
            status: summary.status,
            error: summary.error,
            evidenceError: summary.evidenceError,
            unjoined,
            cells: summary.cells.map(({ name, status, cleanup, oracleError }) => ({
              name,
              status,
              cleanup,
              oracleError,
            })),
          }),
        ),
      )}`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[installed-terminal] terminal-error ${JSON.stringify(diagnostic(error instanceof Error ? error.stack : error))}`,
  );
  process.exitCode = 1;
} finally {
  if (process.exitCode) {
    console.error(`[installed-terminal] FAILED (exit ${process.exitCode})`);
  }
}
