#!/usr/bin/env node
// Manual full-source container/Crabbox proof; never run on an operator host.
// timeout 3600 node --import ./scripts/tsx.mjs scripts/e2e/lib/plugin-update/cohort-rollback-scenario.mjs
// OPENCLAW_CURRENT_PACKAGE_TGZ may reuse a caller-qualified canonical current-source package.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { writePackageDistInventoryForPublish } from "../../../lib/package-dist-inventory.ts";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
import { stampFixtureVersion } from "../update-first-hop-package-fixtures.mjs";

assert(
  fs.existsSync("/.dockerenv") ||
    fs.existsSync("/run/.containerenv") ||
    process.env.OPENCLAW_TESTBOX === "1",
  "This manual scenario requires an isolated container or Crabbox/Testbox.",
);
const repo = process.cwd();
const prepared = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
const tempBase = fs.realpathSync(os.tmpdir());
assert(fs.statSync(tempBase).mode & 0o1000, "TMPDIR must be a sticky temporary directory");
const root = fs.mkdtempSync(path.join(tempBase, "openclaw-cohort-rollback-"));
fs.chmodSync(root, 0o700);
const writeJson = (name, value) =>
  fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const node = process.execPath;
const originalPath = process.env.PATH;
const testbox = process.env.OPENCLAW_TESTBOX;
assert(originalPath, "PATH must identify the isolated runner's tools");
// Children inherit only the fixture's state and public-registry access, never operator credentials.
for (const name of Object.keys(process.env)) {
  delete process.env[name];
}
Object.assign(process.env, {
  PATH: originalPath,
  CI: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
  TMPDIR: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  TEMP: path.join(root, "tmp"),
  npm_config_prefix: path.join(root, "prefix"),
  NPM_CONFIG_PREFIX: path.join(root, "prefix"),
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_userconfig: path.join(root, "npmrc"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_loglevel: "error",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_NO_ONBOARD: "1",
});
if (testbox) {
  process.env.OPENCLAW_TESTBOX = testbox;
}
for (const directory of ["home", "state", "tmp", "registry", "npm-cache"]) {
  fs.mkdirSync(path.join(root, directory), { mode: directory === "tmp" ? 0o1700 : 0o700 });
}
fs.writeFileSync(path.join(root, "npmrc"), "", { mode: 0o600 });
let activeCommand;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    // GNU timeout forwards this signal to its owned command group and waits for it.
    activeCommand?.kill(signal);
  });
}
async function command(label, seconds, executable, args, allowFailure = false) {
  assert(!interrupted, "scenario interrupted");
  const out = fs.openSync(path.join(root, `${label}.json`), "w", 0o600);
  const err = fs.openSync(path.join(root, `${label}.err`), "w", 0o600);
  let result;
  try {
    const child = spawn("timeout", [String(seconds), executable, ...args], {
      cwd: repo,
      env: process.env,
      stdio: ["ignore", out, err],
    });
    activeCommand = child;
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
  } finally {
    activeCommand = undefined;
    fs.closeSync(out);
    fs.closeSync(err);
  }
  assert(!interrupted, "scenario interrupted");
  if (!allowFailure) {
    assert.equal(result.status, 0, `${label} failed; see ${root}/${label}.err`);
  }
  return result.status;
}
function sourceIdentity() {
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    assert.equal(result.status, 0, "source identity requires a full checkout");
    return result.stdout;
  };
  const files = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "src",
    "packages",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
  ])
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const digest = createHash("sha256");
  for (const file of files) {
    if (fs.statSync(file).isFile()) {
      digest.update(file).update("\0").update(fs.readFileSync(file));
    }
  }
  return { head: git(["rev-parse", "HEAD"]).trim(), treeSha256: digest.digest("hex") };
}
const identity = {
  testOnly: true,
  baselineKind: "current checkout compatible baseline, not a released stable CLI",
  source: sourceIdentity(),
  prebuiltBaseline: Boolean(prepared),
};
writeJson("identity.json", identity);
console.log(`Cohort rollback evidence: ${root}`);
let registry;
async function stopRegistry() {
  if (!registry) {
    return;
  }
  const owned = registry;
  registry = undefined;
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    owned.child.kill("SIGTERM");
  }
  let timer;
  try {
    await Promise.race([
      owned.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Fixture registry ${owned.child.pid} did not exit`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    fs.closeSync(owned.log);
  }
}
async function serve(versions) {
  const portFile = path.join(root, "registry", `port-${versions.length}`);
  const log = fs.openSync(`${portFile}.log`, "w", 0o600);
  const args = versions.flatMap((version) => [
    "@example/cohort-rollback-fixture",
    version,
    path.join(root, `plugin-${version}.tgz`),
  ]);
  const child = spawn(
    node,
    ["scripts/e2e/lib/plugins/npm-registry-server.mjs", portFile, ...args],
    {
      cwd: repo,
      env: { ...process.env, OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org" },
      stdio: ["ignore", log, log],
    },
  );
  const owned = {
    child,
    log,
    error: undefined,
    exited: new Promise((resolve) => {
      child.once("close", resolve);
    }),
  };
  child.once("error", (error) => {
    owned.error = error;
  });
  registry = owned;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt++) {
    assert(!interrupted, "scenario interrupted");
    if (owned.error) {
      throw new Error("Fixture registry failed to start", { cause: owned.error });
    }
    assert.equal(child.exitCode, null, "fixture registry exited before readiness");
    await delay(100);
  }
  assert(fs.existsSync(portFile), "fixture registry did not publish its port");
  process.env.npm_config_registry =
    process.env.NPM_CONFIG_REGISTRY = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8")}`;
}
try {
  if (prepared) {
    fs.copyFileSync(path.resolve(prepared), path.join(root, "baseline.tgz"));
    identity.prebuiltSourceQualification =
      "Caller owns binding this tarball to the recorded source tree; hashes below identify exact bytes.";
  } else {
    await command("package-build", 1800, node, [
      "scripts/package-openclaw-for-docker.mjs",
      "--source-dir",
      repo,
      "--runtime-only",
      "--allow-unreleased-changelog",
      "--output-dir",
      root,
      "--output-name",
      "baseline.tgz",
    ]);
    assert.deepEqual(sourceIdentity(), identity.source, "source changed while packing");
  }
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(candidate, { mode: 0o700 });
  await command("unpack-candidate", 120, "tar", [
    "-xzf",
    path.join(root, "baseline.tgz"),
    "-C",
    candidate,
  ]);
  const packageRoot = path.join(candidate, "package");
  const baselineVersion = json(path.join(packageRoot, "package.json")).version;
  const match = /^(\d{4})\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/iu.exec(baselineVersion);
  assert(match, "fixture baseline must have a calendar version");
  const candidateVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  identity.baselineBuild = json(path.join(packageRoot, "dist/build-info.json"));
  assert.equal(
    identity.baselineBuild.commit,
    identity.source.head,
    "package was built from another commit",
  );
  stampFixtureVersion(packageRoot, candidateVersion); // Test-only stamp; no product version changes.
  const faultMarker = "COHORT_FIXTURE_AFTER_INDEX_PUBLICATION";
  const faultPath = path.join(root, "fault.json");
  const sites = [];
  for (const entry of json(path.join(packageRoot, "dist/postinstall-content-inventory.json"))) {
    if (!/\.m?js$/u.test(entry.path)) {
      continue;
    }
    const file = path.join(packageRoot, entry.path);
    const code = fs.readFileSync(file, "utf8");
    const owner = code.indexOf("async function updatePluginsAfterCoreUpdateWithLease(");
    if (owner < 0) {
      continue;
    }
    assert.equal(
      code.indexOf("async function updatePluginsAfterCoreUpdateWithLease(", owner + 1),
      -1,
    );
    const publish = code.indexOf("await commitPluginInstallRecordsWithConfig(", owner);
    const refresh = code.indexOf("await refreshPluginRegistryAfterConfigMutation(", publish);
    assert(publish > owner && refresh > publish, "compiled publication boundary changed");
    // TEST ONLY: observe the actual committed canonical record, then fail verification.
    const fault = `{
      const { DatabaseSync } = await import('node:sqlite');
      const fs = await import('node:fs');
      const db = new DatabaseSync(process.env.OPENCLAW_STATE_DIR + '/state/openclaw.sqlite', {readOnly:true});
      let record;
      try {
        const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();
        record = JSON.parse(row.value_json).index.installRecords['cohort-rollback-fixture'];
      } finally { db.close(); }
      if ((record.version ?? record.resolvedVersion) !== '2.0.0') {
        throw new Error('Fixture plugin publication was not reached');
      }
      fs.writeFileSync(${JSON.stringify(faultPath)}, JSON.stringify({
        testOnly: true, marker: ${JSON.stringify(faultMarker)}, record, pid: process.pid
      }));
      throw new Error(${JSON.stringify(faultMarker)});
    }\n`;
    fs.writeFileSync(file, code.slice(0, refresh) + fault + code.slice(refresh));
    sites.push({ path: entry.path, beforeSha256: entry.sha256, afterSha256: hash(file) });
  }
  assert.equal(sites.length, 1, "expected exactly one compiled publication fault site");
  await writePackageDistInventoryForPublish(packageRoot);
  await command("pack-candidate", 120, "tar", [
    "-czf",
    path.join(root, "candidate.tgz"),
    "-C",
    candidate,
    "package",
  ]);
  for (const [version, floor] of [
    ["1.0.0", baselineVersion],
    ["2.0.0", candidateVersion],
  ]) {
    const directory = path.join(root, `plugin-${version}`, "package");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "@example/cohort-rollback-fixture",
        version,
        openclaw: { extensions: ["./index.js"], compat: { pluginApi: `>=${floor}` } },
      }),
    );
    fs.writeFileSync(
      path.join(directory, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cohort-rollback-fixture",
        activation: { onStartup: true },
        configSchema: {
          type: "object",
          properties: { greeting: { type: "string" } },
          additionalProperties: false,
        },
      }),
    );
    fs.writeFileSync(
      path.join(directory, "index.js"),
      `module.exports={id:'cohort-rollback-fixture',name:'Cohort rollback fixture',register(api){api.registerGatewayMethod('cohort.fixture',({respond})=>respond(true,{version:'${version}',greeting:api.pluginConfig?.greeting}),{scope:'operator.read'});}};\n`,
    );
    await command(`pack-plugin-${version}`, 120, "tar", [
      "-czf",
      path.join(root, `plugin-${version}.tgz`),
      "-C",
      path.dirname(directory),
      "package",
    ]);
  }
  Object.assign(identity, {
    baselineVersion,
    candidateVersion,
    fixtureVersionStamp: true,
    fault: { marker: faultMarker, sites },
    tarballs: Object.fromEntries(
      ["baseline", "candidate", "plugin-1.0.0", "plugin-2.0.0"].map((name) => [
        name,
        hash(path.join(root, `${name}.tgz`)),
      ]),
    ),
  });
  writeJson("identity.json", identity);
  await command("install-core", 600, "npm", [
    "install",
    "-g",
    "--prefix",
    path.join(root, "prefix"),
    "--omit=optional",
    path.join(root, "baseline.tgz"),
  ]);
  const installed = path.join(root, "prefix/lib/node_modules/openclaw");
  const cli = path.join(installed, "openclaw.mjs");
  process.env.PATH = `${root}/prefix/bin:${process.env.PATH}`;
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: { mode: "local" },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      plugins: { entries: { codex: { enabled: false } } },
    }),
  );
  await serve(["1.0.0"]);
  await command("install-plugin", 300, node, [
    cli,
    "plugins",
    "install",
    "npm:@example/cohort-rollback-fixture@latest",
    "--force",
    "--accept-capabilities",
  ]);
  await command("config-set", 120, node, [
    cli,
    "config",
    "set",
    "plugins.entries.cohort-rollback-fixture.config.greeting",
    "preserve-cohort-settings",
  ]);
  await command("plugin-before", 120, node, [
    cli,
    "plugins",
    "inspect",
    "cohort-rollback-fixture",
    "--runtime",
    "--json",
  ]);
  const before = readPluginInstallRecords()["cohort-rollback-fixture"];
  const beforeStat = fs.statSync(before.installPath, { bigint: true });
  assert.equal(before.version ?? before.resolvedVersion, "1.0.0");
  assert.equal(json(path.join(before.installPath, "package.json")).version, "1.0.0");
  assert.equal(json(path.join(root, "plugin-before.json")).plugin.status, "loaded");
  identity.installedBefore = {
    manifestSha256: hash(path.join(installed, "package.json")),
    entrySha256: hash(cli),
    build: json(path.join(installed, "dist/build-info.json")),
    plugin: {
      record: before,
      manifestSha256: hash(path.join(before.installPath, "package.json")),
      dev: String(beforeStat.dev),
      ino: String(beforeStat.ino),
    },
  };
  await stopRegistry();
  await serve(["1.0.0", "2.0.0"]);
  await command("backup-before", 180, node, [
    cli,
    "backup",
    "create",
    "--verify",
    "--output",
    path.join(root, "pre-update-backup.tar.gz"),
    "--json",
  ]);
  assert.equal(json(path.join(root, "backup-before.json")).verified, true);
  identity.backupSha256 = hash(path.join(root, "pre-update-backup.tar.gz"));
  writeJson("identity.json", identity);
  const updaterExit = await command(
    "update",
    900,
    node,
    [
      cli,
      "update",
      "--tag",
      path.join(root, "candidate.tgz"),
      "--yes",
      "--accept-capabilities",
      "--no-restart",
      "--timeout",
      "840",
      "--json",
    ],
    true,
  );
  const inspectExit = await command(
    "plugin-after",
    120,
    node,
    [cli, "plugins", "inspect", "cohort-rollback-fixture", "--runtime", "--json"],
    true,
  );
  await command("plugins-after", 120, node, [cli, "plugins", "list", "--json"]);
  const record = readPluginInstallRecords()["cohort-rollback-fixture"];
  const artifact = record?.installPath && json(path.join(record.installPath, "package.json"));
  const core = json(path.join(installed, "package.json"));
  const config = json(process.env.OPENCLAW_CONFIG_PATH);
  const update = json(path.join(root, "update.json"));
  const fault = fs.existsSync(faultPath) ? json(faultPath) : undefined;
  const result = {
    status: "inconclusive",
    updaterExit,
    inspectExit,
    coreVersion: core.version,
    record,
    artifactVersion: artifact?.version,
    settings: config.plugins?.entries?.["cohort-rollback-fixture"]?.config,
    fault,
    update,
  };
  try {
    assert.notEqual(updaterExit, 0, "injected failure did not fail the registered updater");
    assert.equal(
      fault?.marker,
      faultMarker,
      "the registered updater missed the publication boundary",
    );
    assert.equal(core.version, baselineVersion, "previous core was not restored");
    const apiDiagnostics = fs.readFileSync(path.join(root, "plugins-after.json"), "utf8");
    if (
      (record?.version ?? record?.resolvedVersion) === "2.0.0" &&
      artifact?.version === "2.0.0" &&
      result.settings?.greeting === "preserve-cohort-settings" &&
      /requires plugin API|plugin-api-incompatible|plugin API.*host/iu.test(apiDiagnostics)
    ) {
      result.status = "RED";
    }
    assert.equal(
      record?.version ?? record?.resolvedVersion,
      "1.0.0",
      "core rollback retained the incompatible canonical plugin record",
    );
    assert.equal(
      artifact?.version,
      "1.0.0",
      "core rollback retained the incompatible plugin artifact",
    );
    assert.deepEqual(record, before, "rollback changed the prior matching install record");
    assert.equal(
      hash(path.join(record.installPath, "package.json")),
      identity.installedBefore.plugin.manifestSha256,
    );
    const restored = fs.statSync(record.installPath, { bigint: true });
    assert.deepEqual(
      [String(restored.dev), String(restored.ino)],
      [String(beforeStat.dev), String(beforeStat.ino)],
    );
    assert.equal(inspectExit, 0);
    assert.equal(json(path.join(root, "plugin-after.json")).plugin.status, "loaded");
    assert.equal(result.settings?.greeting, "preserve-cohort-settings");
    assert.equal(
      hash(path.join(installed, "package.json")),
      identity.installedBefore.manifestSha256,
    );
    assert.equal(hash(cli), identity.installedBefore.entrySha256);
    const db = new DatabaseSync(
      path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"),
      { readOnly: true },
    );
    try {
      assert.deepEqual(
        db
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE (state_key >= 'update.recovery.' AND state_key < 'update.recovery/') OR (state_key >= 'update.pluginCohort.' AND state_key < 'update.pluginCohort/')",
          )
          .all(),
        [],
        "cohort recovery pair was not cleared",
      );
    } finally {
      db.close();
    }
    assert.equal(hash(path.join(root, "pre-update-backup.tar.gz")), identity.backupSha256);
    assert(!interrupted, "scenario interrupted");
    result.status = "GREEN";
  } finally {
    writeJson("result.json", result);
  }
  console.log(
    `GREEN: registered core rollback restored the compatible plugin and settings. Identity: ${root}/identity.json`,
  );
} finally {
  await stopRegistry();
}
