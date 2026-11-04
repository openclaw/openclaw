// Task-only BR proof adapter. Never ship this workflow or its fixture adapters.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

export function digest(file, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const length = fs.readSync(fd, buffer);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest(encoding);
}
// Frozen original RED inputs: out/progress/deep5/npm-selection.json and
// tmp/proof/deep5/receipts/native/2026.11.5-beta.1-systemd/summary.json.
const BETA_PIN = {
  version: "2026.11.5-beta.1",
  integrity: "sha512-YUCw8eBhiUbA8YejKvHWeVsVMkmMIes6Vi1Ml6vY/BmZfSKgxwTXDBmbPAeZ/khjxLA2U10Bf8Ae239LZ/WuzQ==",
  shasum: "cc6d3b105b938acaf9301f17daa3985acd29fce0",
  tarball: "https://registry.npmjs.org/openclaw/-/openclaw-2026.11.5-beta.1.tgz",
  build: {
    version: "2026.11.5-beta.1",
    commit: "bc061f935bfd79ad09e3e98c6df9f2e8f1e28bea",
    builtAt: "2026-11-03T23:00:21.511Z",
    buildId: "2026.11.5-beta.1-release-bc061f935bfd-2026-11-03T23-00-21.511Z",
  },
};
const MARKER = "BR beta original conversation content survives candidate update and backup restore.";
const SESSIONS = [
  ["agent:main:main", "upgrade-main-session"],
  ["agent:main:+15551234567", "upgrade-direct-session"],
  ["agent:main:slack:channel:cupgrade", "upgrade-group-session"],
];
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function contained(root, relative) {
  assert(typeof relative === "string" && !path.isAbsolute(relative));
  const file = path.resolve(root, relative);
  assert(file.startsWith(path.resolve(root) + path.sep), "Proof path escapes its owner");
  return file;
}

// Compare logical rows and schema: SQLite backup legitimately changes page layout.
function history(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const quickCheck = db.prepare("PRAGMA quick_check").all().map(Object.values).flat();
    assert.deepEqual(quickCheck, ["ok"]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map(({ name }) => name);
    return {
      quickCheck,
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
      schemaSha256: createHash("sha256").update(JSON.stringify(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all())).digest("hex"),
      mainConversation: db.prepare("SELECT session_id, seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(SESSIONS[0][1]).flatMap((row) => {
          const text = row.event_json ?? (row.event_zstd && zstdDecompressSync(row.event_zstd, { maxOutputLength: 4 * 1024 * 1024 }).toString("utf8"));
          if (!text) return [];
          const event = JSON.parse(text);
          if (event.message?.role !== "assistant" || !Array.isArray(event.message.content) ||
            !event.message.content.some((part) => part.type === "text" && part.text === MARKER)) return [];
          return [{ sessionId: row.session_id, seq: row.seq, messageId: event.id,
            role: event.message.role, contentSha256: createHash("sha256").update(JSON.stringify(event.message.content)).digest("hex") }];
        }),
      tables: tables.map((name) => {
        const statement = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
        statement.setReadBigInts(true);
        const rows = statement.all().map((row) => JSON.stringify(row, (_, value) =>
          typeof value === "bigint" ? { integer: value.toString() } : value)).sort();
        return { name, rows: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
      }),
    };
  } finally { db.close(); }
}
function histories(state) {
  const agents = path.join(state, "agents");
  return fs.readdirSync(agents, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map(({ name }) => `agents/${name}/agent/openclaw-agent.sqlite`)
    .filter((relative) => fs.existsSync(path.join(state, relative)))
    .sort().map((relative) => ({ relative, ...history(path.join(state, relative)) }));
}
function publicJson(result) {
  const text = result.stdout;
  return JSON.parse(text.slice(text.indexOf("{")));
}
function gateway(ctx, name, method, params, allowFailure = false) {
  const config = json(ctx.env.OPENCLAW_CONFIG_PATH);
  return ctx.asUser(name, ctx.cli, ["gateway", "call", method,
    "--url", `ws://127.0.0.1:${config.gateway.port}`, "--token", config.gateway.auth.token,
    "--timeout", "30000", "--json", "--params", JSON.stringify(params)], { allowFailure });
}
function publicHistory(ctx, stage) {
  const results = [];
  const errors = [];
  for (const [index, [key, sessionId]] of SESSIONS.entries()) {
    try {
      const result = gateway(ctx, `history-${stage}-${index}`, "chat.history",
        { agentId: "main", sessionKey: key, limit: 100 }, true);
      assert.equal(result.status, 0, `Public history failed for ${key}`);
      const value = publicJson(result);
      assert.equal(value.sessionId, sessionId, "Public history changed fixture session identity");
      assert(Array.isArray(value.messages));
      // Explicit client content contract: order, role and complete content value.
      // IDs/timestamps/delivery metadata are not user conversation content.
      const messages = value.messages.map((message) => {
        assert(typeof message.role === "string" && Object.hasOwn(message, "content"));
        return { role: message.role, content: message.content };
      });
      results.push({ key, sessionId, messages });
    } catch (error) { errors.push(`${key}: ${error}`); }
  }
  save(path.join(ctx.cellDir, `history-${stage}-projection.json`), { results, errors });
  assert.deepEqual(errors, [], "Public history observations incomplete");
  assert(results[0].messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes(MARKER)),
    "Synthetic assistant content missing from existing main conversation");
  return results;
}
function registryIdentity(packageRoot, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const records = [];
  const copy = (relative) => {
    const source = path.join(packageRoot, relative);
    if (!fs.existsSync(source)) return;
    const target = contained(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    records.push({ path: relative, bytes: fs.statSync(source).size, sha256: digest(source) });
  };
  for (const file of ["package.json", "dist/build-info.json"]) copy(file);
  for (const root of ["dist/extensions", "dist-runtime/extensions", "extensions"]) {
    const directory = path.join(packageRoot, root);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const file of ["package.json", "openclaw.plugin.json"]) copy(path.join(root, entry.name, file));
    }
  }
  save(path.join(destination, "identity.json"), records);
  return records;
}
function assertRegistryPin(records, phase) {
  const pin = json(new URL("./br-beta-registry-pin.json", import.meta.url));
  assert.equal(pin.productHead, "bcae09093b5a06099cd3a3f0f3d5f4e4b499ad7f");
  assert.equal(pin.packageSha256, "4f67df079a8e179589aeecbf9a5b1546423856723132e40b7ef4a2c5c17a6448");
  assert.deepEqual([...records].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), pin[phase],
    `Installed ${phase} registry differs from the retained exact package witness`);
}

function captureInventory(ctx, stage, before) {
  const root = `${ctx.state}.update-captures`;
  const captures = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map(({ name }) => {
      const file = path.join(root, name, "manifest.json");
      const manifest = fs.existsSync(file) ? json(file) : null;
      const preserveFiles = stage === "before" || before.captures.some((entry) => entry.name === name);
      const files = manifest && preserveFiles ? manifest.entries.filter((entry) => entry.kind === "file").map((entry) => {
        const payload = contained(path.dirname(file), entry.archivePath);
        const stat = fs.lstatSync(payload);
        assert(stat.isFile(), "Earlier capture payload is not a regular file");
        const sha256 = digest(payload);
        assert.equal(stat.size, entry.size);
        assert.equal(sha256, entry.sha256, "Earlier capture payload integrity failed");
        return { archivePath: entry.archivePath, size: stat.size, sha256 };
      }) : [];
      return { name, manifestPath: file, manifest, files,
        sha256: fs.existsSync(file) ? digest(file) : null,
        partialPresent: fs.lstatSync(`${file}.partial`, { throwIfNoEntry: false }) !== undefined };
    }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const ledger = publicJson(ctx.asUser(`capture-ledger-${stage}`, ctx.cli, ["update", "status", "--json"]));
  const inventory = { stage, root, captures, ledger };
  save(path.join(ctx.cellDir, `capture-inventory-${stage}.json`), inventory);
  return inventory;
}

// The capture belongs to the actual update, not every earlier Doctor in this home.
// Pure selection is shared by the fixture and its positive/negative controls.
export function selectUpdateCapture({ before, after, result, owner }) {
  assert.equal(typeof result?.runId, "string", "Updater run identity missing");
  assert.equal(result.run?.runId, result.runId, "Updater result/ledger identity mismatch");
  const run = after.ledger.lastRun;
  assert.equal(run?.runId, result.runId, "Observed ledger belongs to a foreign run");
  assert.notEqual(before.ledger.lastRun?.runId, result.runId, "Update reused the pre-update ledger");
  assert.equal(run.origin.admission?.owner, "candidate");
  assert.equal(run.origin.admission?.protocol, 1);
  assert.equal(run.origin.admission?.candidateVersion, owner.candidateVersion);
  assert.equal(run.origin.candidateAdmission?.protocol, 1);
  assert.equal(run.origin.candidateAdmission?.verdict, "admit");
  assert.equal(run.origin.candidateAdmission?.facts.installedVersion, owner.baselineVersion);
  assert.equal(run.origin.candidateAdmission?.facts.candidateVersion, owner.candidateVersion);
  assert.equal(run.before.buildId, owner.baselineBuildId);
  assert.equal(run.after.buildId, owner.candidateBuildId);
  for (const old of before.captures) {
    const retained = after.captures.filter((entry) => entry.name === old.name);
    assert.equal(retained.length, 1, "Earlier capture disappeared or became ambiguous");
    assert.equal(retained[0].sha256, old.sha256, "Earlier capture manifest changed");
    assert.deepEqual(retained[0].files, old.files, "Earlier capture payload bytes changed");
  }
  const matches = after.captures.filter((entry) => entry.manifest?.runId === result.runId);
  assert.equal(matches.length, 1, "Expected one capture owned by this updater run");
  const selected = matches[0];
  assert.equal(selected.name, result.runId, "Capture directory differs from its owner run");
  assert(!before.captures.some((entry) => entry.name === selected.name), "Selected capture predates update");
  const manifest = selected.manifest;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.kind, "update-recovery");
  assert.equal(manifest.generation.kind, "baseline");
  for (const key of ["stateDir", "configPath", "installRoot"]) assert.equal(manifest[key], owner[key]);
  const drivers = [run.origin.driver, ...(run.origin.previousDrivers ?? [])];
  const driverMatches = (driver) => driver && typeof driver.host === "string" &&
    Number.isSafeInteger(driver.pid) && driver.pid > 0 && typeof driver.startIdentity === "string" &&
    drivers.some((candidate) => candidate && ["host", "pid", "startIdentity"].every((key) => candidate[key] === driver[key]));
  assert(driverMatches(manifest.creator), "Capture creator is foreign to the update driver chain");
  assert(Array.isArray(manifest.drivers) && manifest.drivers.length > 0 && manifest.drivers.every(driverMatches),
    "Capture driver admission is foreign");
  return selected;
}
export function captureBefore(ctx) {
  const { state, home, prefix, cli, packageRoot, asUser, cellDir, env } = ctx;
  const proofRoot = path.join(home, "br-proof");
  asUser("proof-directory", "mkdir", ["-p", proofRoot]);
  assert.deepEqual(json(path.join(packageRoot, "dist/build-info.json")), BETA_PIN.build,
    "Installed/serving beta differs from the retained real RED build");
  const injected = publicJson(gateway(ctx, "seed-assistant-content", "chat.inject", {
    agentId: "main", sessionKey: SESSIONS[0][0], message: MARKER,
  }));
  assert.equal(injected.ok, true);
  assert.equal(typeof injected.messageId, "string");
  const beforePublicHistory = publicHistory(ctx, "before");
  const beforeConfig = path.join(cellDir, "config-before.json");
  fs.copyFileSync(env.OPENCLAW_CONFIG_PATH, beforeConfig);
  const before = histories(state);
  const specimen = before.flatMap((agent) => agent.mainConversation);
  assert.equal(specimen.length, 1, "Baseline must contain the injected message in the existing main conversation");
  assert.equal(specimen[0].messageId, injected.messageId, "Baseline database lacks the committed injection identity");
  assert(before.some((agent) => agent.tables.some((table) => table.name === "transcript_events" && table.rows > 0)),
    "Baseline has no real transcript specimen");
  const retainedPrefix = path.join(proofRoot, "baseline-prefix");
  fs.cpSync(prefix, retainedPrefix, { recursive: true, verbatimSymlinks: true });
  const retainedPackage = path.join(retainedPrefix, "lib/node_modules/openclaw");
  const entry = ["dist/index.mjs", "dist/index.js"].map((file) => path.join(retainedPackage, file)).find(fs.existsSync);
  assert(entry, "Retained baseline CLI missing");
  const archive = path.join(proofRoot, "before-update.tar.gz");
  const created = publicJson(asUser("backup-create", cli, ["backup", "create", "--verify", "--output", archive, "--json"], { timeout: 900_000 }));
  assert.equal(created.verified, true);
  assert.equal(created.dryRun, false);
  assert.equal(path.resolve(created.archivePath), archive);
  const assets = created.assets.filter((asset) => asset.kind === "state" && fs.realpathSync(asset.sourcePath) === fs.realpathSync(state));
  assert.equal(assets.length, 1, "Verified backup lacks unambiguous original state");
  assert.deepEqual(histories(state), before, "Backup changed baseline history");
  assert.equal(digest(env.OPENCLAW_CONFIG_PATH), digest(beforeConfig), "Backup changed baseline config");
  // Keep the actual published archive, not only its npm integrity string.
  const version = json(path.join(packageRoot, "package.json")).version;
  assert.equal(version, BETA_PIN.version);
  const dist = publicJson(asUser("baseline-dist", "npm", ["view", `openclaw@${version}`, "dist", "--json"]));
  for (const key of ["integrity", "shasum", "tarball"]) assert.equal(dist[key], BETA_PIN[key], `Published beta ${key} drifted from frozen selection`);
  const packedResult = asUser("baseline-package", "npm", ["pack", `openclaw@${version}`, "--pack-destination", proofRoot, "--json"], { timeout: 180_000 });
  const packed = JSON.parse(packedResult.stdout);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, `openclaw-${BETA_PIN.version}.tgz`);
  const baselineArchive = contained(proofRoot, packed[0].filename);
  assert.equal(`sha512-${digest(baselineArchive, "sha512", "base64")}`, BETA_PIN.integrity);
  assert.equal(digest(baselineArchive, "sha1"), BETA_PIN.shasum);
  const baselineRegistry = registryIdentity(packageRoot, path.join(cellDir, "registries", "baseline"));
  assertRegistryPin(baselineRegistry, "baseline");
  const proof = { proofRoot, retainedPrefix, entry, archive, archiveSha256: digest(archive), stateAsset: assets[0].archivePath,
    beforeConfig, beforeConfigSha256: digest(beforeConfig), beforeHistory: before, beforePublicHistory,
    baselineArchive, baselinePin: BETA_PIN, baselineRegistry, injectedMessageId: injected.messageId,
    beforeCaptures: captureInventory(ctx, "before"), errors: [],
    externalRegistry: "not used; package archives and installed bundled manifests/identity exported without dependency trees" };
  assert(proof.beforeCaptures.captures.some((capture) => capture.manifest?.runId.startsWith("doctor-")),
    "Fixture did not retain its initial Doctor capture; the original two-capture regression is absent");
  save(path.join(cellDir, "original-before.json"), proof);
  return proof;
}
export function collectAfter(ctx, proof, updateResult) {
  const { state, home, env, cellDir, run, user } = ctx;
  const observe = (name, read) => {
    try { proof[name] = read(); } catch (error) { proof.errors.push(`${name}: ${error}`); }
    save(path.join(cellDir, "original-after.json"), proof);
  };
  observe("afterConfigSha256", () => {
    fs.copyFileSync(env.OPENCLAW_CONFIG_PATH, path.join(cellDir, "config-after.json"));
    return digest(env.OPENCLAW_CONFIG_PATH);
  });
  observe("afterHistory", () => histories(state));
  observe("afterPublicHistory", () => {
    const value = publicHistory(ctx, "after");
    assert.deepEqual(value, proof.beforePublicHistory, "Live candidate changed conversation role/content");
    return value;
  });
  observe("candidateRegistry", () => {
    const records = registryIdentity(ctx.packageRoot, path.join(cellDir, "registries", "after"));
    assertRegistryPin(records, "after");
    return records;
  });
  observe("afterCaptures", () => captureInventory(ctx, "after", proof.beforeCaptures));
  observe("originalCapture", () => {
    const candidate = json(path.join(ctx.packageRoot, "dist/build-info.json"));
    const selected = selectUpdateCapture({ before: proof.beforeCaptures, after: proof.afterCaptures,
      result: updateResult, owner: { stateDir: state, configPath: env.OPENCLAW_CONFIG_PATH,
        installRoot: ctx.packageRoot, baselineVersion: proof.baselinePin.version,
        baselineBuildId: proof.baselinePin.build.buildId, candidateVersion: candidate.version, candidateBuildId: candidate.buildId } });
    const manifestPath = selected.manifestPath;
    const partial = `${manifestPath}.partial`;
    const read = proof.captureRead = { runId: updateResult.runId, manifest: manifestPath,
      manifestSha256: selected.sha256, partialObservations: [], files: [], agentHistories: [] };
    const checkpoint = () => save(path.join(cellDir, "capture-read.json"), read);
    const observePartial = (stage) => {
      const present = fs.lstatSync(partial, { throwIfNoEntry: false }) !== undefined;
      read.partialObservations.push({ stage, present }); checkpoint();
      assert.equal(present, false, `Original capture publication incomplete at ${stage}`);
    };
    observePartial("before-payload-read");
    const manifest = json(manifestPath);
    assert.equal(digest(manifestPath), selected.sha256, "Selected capture manifest changed before read");
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.kind, "update-recovery");
    assert.equal(manifest.generation.kind, "baseline");
    assert.equal(fs.realpathSync(manifest.stateDir), fs.realpathSync(state));
    for (const entry of manifest.entries.filter((entry) => entry.kind === "file")) {
      const payload = contained(path.dirname(manifestPath), entry.archivePath);
      assert.equal(fs.statSync(payload).size, entry.size);
      assert.equal(digest(payload), entry.sha256, "Original capture payload digest mismatch");
      read.files.push({ sourcePath: entry.sourcePath, archivePath: entry.archivePath, size: entry.size, sha256: entry.sha256 }); checkpoint();
    }
    const config = manifest.entries.find((entry) => entry.sourcePath === env.OPENCLAW_CONFIG_PATH);
    assert(config && config.kind === "file", "Original capture lacks config bytes");
    assert.equal(config.sha256, proof.beforeConfigSha256, "Original capture changed source config");
    for (const expected of proof.beforeHistory) {
      const entry = manifest.entries.find((entry) => entry.sourcePath === path.join(state, expected.relative));
      assert(entry?.sqlite, "Original capture lacks baseline agent database");
      const captured = history(contained(path.dirname(manifestPath), entry.archivePath));
      read.agentHistories.push({ sourcePath: entry.sourcePath, archivePath: entry.archivePath, ...captured }); checkpoint();
      assert.deepEqual(captured,
        Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "relative")), "Original capture history changed");
    }
    const specimen = read.agentHistories.flatMap((agent) => agent.mainConversation);
    assert.equal(specimen.length, 1);
    assert.equal(specimen[0].messageId, proof.injectedMessageId, "Captured database lost the existing main conversation injection");
    observePartial("after-payload-and-history-read");
    assert.equal(digest(manifestPath), selected.sha256, "Selected capture manifest changed during read");
    read.verified = true; checkpoint();
    return { manifest: manifestPath, sha256: digest(manifestPath), entries: manifest.entries.length,
      runId: updateResult.runId, readReceipt: path.join(cellDir, "capture-read.json"), verified: true };
  });
  observe("restore", () => {
    assert.equal(digest(proof.archive), proof.archiveSha256, "Verified backup changed");
    const selector = path.join(home, "br-proof", "restore-selector");
    const target = path.join(home, "br-proof", "restored");
    ctx.asUser("restore-selector-directory", "mkdir", ["-p", selector]);
    const restoreEnv = { ...env, HOME: selector, USERPROFILE: selector, OPENCLAW_HOME: selector,
      OPENCLAW_STATE_DIR: path.join(selector, ".openclaw"), OPENCLAW_CONFIG_PATH: path.join(selector, ".openclaw/openclaw.json") };
    const restored = publicJson(run("backup-restore", "runuser", ["-u", user, "--", "env", "-i",
      ...Object.entries(restoreEnv).map(([key, value]) => `${key}=${value}`), "node", proof.entry,
      "backup", "restore", proof.archive, "--target", target, "--json"], { cwd: home, timeout: 900_000 }));
    assert.equal(restored.ok, true, "Public backup owner refused restore");
    assert.equal(path.resolve(restored.targetPath), target);
    const restoredState = contained(target, proof.stateAsset);
    const restoredConfigSha256 = digest(path.join(restoredState, "openclaw.json"));
    assert.equal(restoredConfigSha256, proof.beforeConfigSha256);
    const restoredHistory = histories(restoredState);
    save(path.join(cellDir, "restored-history.json"), restoredHistory);
    assert.deepEqual(restoredHistory, proof.beforeHistory, "Restored baseline history changed");
    // The public restore child has exited and its output passed. This private
    // runtime has no remaining consumer; release it before export packing.
    assert.equal(proof.retainedPrefix, path.join(proof.proofRoot, "baseline-prefix"));
    fs.rmSync(proof.retainedPrefix, { recursive: true });
    return { result: restored, state: restoredState, archiveSha256: digest(proof.archive),
      configSha256: restoredConfigSha256, history: restoredHistory, privateRuntimeReleased: true };
  });
  return proof;
}
export function archiveOwned(ctx) {
  const receipt = [];
  const proofRoot = path.join(ctx.home, "br-proof");
  const selected = [["original-captures", `${ctx.state}.update-captures`], ["state-final", ctx.state],
    ["workspace-final", ctx.workspace], ["before-update.tar.gz", path.join(proofRoot, "before-update.tar.gz")],
    ["restored", path.join(proofRoot, "restored")],
    ["baseline-package.tgz", path.join(proofRoot, `openclaw-${BETA_PIN.version}.tgz`)]];
  for (const [name, source] of selected) {
    try {
      if (!fs.existsSync(source)) { receipt.push({ name, source, status: "missing" }); continue; }
      fs.cpSync(source, path.join(ctx.cellDir, name), { recursive: true, verbatimSymlinks: true });
      receipt.push({ name, source, status: "exported" });
    } catch (error) { receipt.push({ name, source, status: "incomplete", error: String(error) }); }
  }
  try { registryIdentity(ctx.packageRoot, path.join(ctx.cellDir, "registries", "closeout")); }
  catch (error) { receipt.push({ name: "registry-closeout", status: "incomplete", error: String(error) }); }
  save(path.join(ctx.cellDir, "export-receipt.json"), receipt);
  return receipt;
}
// Diagnostic bytes only. A running service can change/checkpoint these files
// during copying; this is never used as a coherent SQLite/logical-state oracle.
export function captureVolatile(ctx, label) {
  assert(["native-before-teardown", "closeout-before-teardown"].includes(label));
  const destination = path.join(ctx.cellDir, "forensics", label);
  const receiptFile = path.join(destination, "receipt.json");
  const started = performance.now();
  const receipt = { label, status: "incomplete", startedAt: new Date().toISOString(),
    consistency: "volatile non-atomic forensic copy; not logical coherence or a PASS verdict",
    copies: [], errors: [] };
  const checkpoint = () => {
    try { save(receiptFile, receipt); }
    catch (error) { receipt.status = "incomplete"; receipt.errors.push(`receipt checkpoint: ${error}`); }
  };
  try {
    fs.mkdirSync(destination, { recursive: true });
    checkpoint();
    for (const [name, source] of [["state", ctx.state], ["captures", `${ctx.state}.update-captures`], ["workspace", ctx.workspace]]) {
      const copyStarted = performance.now();
      const entry = { name, source, status: "copying", startedAt: new Date().toISOString() };
      receipt.copies.push(entry);
      checkpoint();
      try {
        if (!fs.existsSync(source)) entry.status = "missing";
        else {
          fs.cpSync(source, path.join(destination, name), { recursive: true, dereference: false, verbatimSymlinks: true });
          entry.status = "copied-volatile";
        }
      } catch (error) { entry.status = "incomplete"; entry.error = String(error); }
      entry.finishedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - copyStarted);
      checkpoint();
    }
  } catch (error) { receipt.errors.push(String(error)); }
  receipt.finishedAt = new Date().toISOString();
  receipt.durationMs = Math.round(performance.now() - started);
  if (receipt.errors.length === 0 && receipt.copies.length === 3 && receipt.copies.every((entry) => entry.status === "copied-volatile")) {
    receipt.status = "captured-volatile";
  }
  checkpoint();
  // Evidence failure must not prevent the native owner's service teardown.
  return receipt;
}
export function closeoutOwned(nativeRoot) {
  const summaryPath = path.join(nativeRoot, "summary.json");
  fs.mkdirSync(nativeRoot, { recursive: true });
  const receipts = [];
  if (!fs.existsSync(summaryPath)) {
    save(path.join(nativeRoot, "closeout.json"), { status: "incomplete", reason: "No registered account summary; no account guessed", receipts });
    return false;
  }
  for (const row of json(summaryPath).cases) {
    const user = path.basename(row.home);
    assert(/^ocsurv[a-f0-9]{12}$/.test(user) && row.home === `/home/${user}` && /^[0-9]+$/.test(row.uid) && Number(row.uid) >= 1000);
    assert.equal(spawnSync("id", ["-u", user], { encoding: "utf8", timeout: 3000 }).stdout.trim(), row.uid,
      "Recorded fixture account identity changed; no teardown authority");
    const context = { home: row.home, state: path.join(row.home, ".openclaw"), workspace: path.join(row.home, "workspace"),
      packageRoot: path.join(row.home, "npm/lib/node_modules/openclaw"), cellDir: contained(nativeRoot, row.version) };
    // Also runs when the native step was terminated before its finally block.
    // Capture before any stop/disable/terminate/kill can retire WAL or scratch.
    const rawBeforeTeardown = captureVolatile(context, "closeout-before-teardown");
    const call = (args) => spawnSync("runuser", ["-u", user, "--", "env", "-i", `HOME=${row.home}`,
      `XDG_RUNTIME_DIR=/run/user/${row.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${row.uid}/bus`,
      "PATH=/usr/bin:/bin", "systemctl", "--user", ...args], { encoding: "utf8", timeout: 15000 });
    const stopped = call(["stop", "openclaw-gateway.service"]);
    const observed = call(["show", "openclaw-gateway.service", "--property=MainPID", "--value"]);
    const linger = spawnSync("loginctl", ["disable-linger", user], { encoding: "utf8", timeout: 5000 });
    // This account was created only by this fixture; settle its updater children
    // before copying a timeout/failure state. Never target another account.
    const terminated = spawnSync("loginctl", ["terminate-user", user], { encoding: "utf8", timeout: 10000 });
    const killed = spawnSync("pkill", ["-KILL", "-u", row.uid], { encoding: "utf8", timeout: 3000 });
    const remaining = spawnSync("pgrep", ["-u", row.uid], { encoding: "utf8", timeout: 3000 });
    const settled = remaining.status === 1;
    const receipt = { user, uid: row.uid, stop: stopped.status, mainPid: observed.stdout.trim(), linger: linger.status,
      terminate: terminated.status, kill: killed.status, processQuery: remaining.status, remainingPids: remaining.stdout.trim(), settled,
      priorStoppedPid: row.stopped?.MainPID,
      rawBeforeTeardown, nativeRawBeforeTeardown: row.rawBeforeTeardown,
      proofComplete: row.status === "passed" && row.originalStateAndRestoreVerified === true, exports: [] };
    receipts.push(receipt);
    if (settled) {
      fs.mkdirSync(context.cellDir, { recursive: true });
      receipt.exports = archiveOwned(context);
    } else receipt.exportGap = "Owned processes unsettled; source evidence preserved, no inconsistent copy claimed";
    save(path.join(nativeRoot, "closeout.json"), { receipts });
  }
  // Disabling linger can already retire the user bus. In that case the native
  // owner's recorded stop plus no remaining UID processes proves settlement.
  const complete = receipts.length === 1 && receipts.every((row) => row.settled &&
    ((row.stop === 0 && row.mainPid === "0") || row.priorStoppedPid === "0") &&
    row.linger === 0 && row.proofComplete && row.rawBeforeTeardown.status === "captured-volatile" &&
    row.nativeRawBeforeTeardown?.status === "captured-volatile" && row.exports.every((entry) => entry.status === "exported"));
  save(path.join(nativeRoot, "closeout.json"), { status: complete ? "complete" : "incomplete", receipts });
  return complete;
}
export function manifestTree(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (relative === "SHA256SUMS.json") continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink()) files.push({ path: relative, link: fs.readlinkSync(file) });
      else { assert(entry.isFile()); files.push({ path: relative, bytes: fs.statSync(file).size, sha256: digest(file) }); }
    }
  }
  visit(root);
  save(path.join(root, "SHA256SUMS.json"), files);
}
