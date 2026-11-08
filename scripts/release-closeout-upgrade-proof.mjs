#!/usr/bin/env node
/**
 * Real published-to-candidate proof: no imported updater implementation, mocks,
 * package relabeling, source patches, services, credentials, or reused installs.
 * Build/pack the exact checkout, then run BOTH lanes with fresh output dirs:
 *   node scripts/release-closeout-upgrade-proof.mjs --lane node --candidate /abs/c.tgz \
 *     --sha256 SHA256 --head FULL_HEAD --out /abs/proof/node
 *   bun scripts/release-closeout-upgrade-proof.mjs --lane bun --candidate /abs/c.tgz \
 *     --sha256 SHA256 --head FULL_HEAD --out /abs/proof/bun
 *   node scripts/release-closeout-upgrade-proof.mjs --verify \
 *     --node-proof /abs/proof/node --bun-proof /abs/proof/bun --head FULL_HEAD --sha256 SHA256
 * Node lane needs supported Node, npm, git, tar. Bun lane needs Linux, actual
 * Bun >=1.4.4, git/tar/shell tools, NO Node in PATH or conventional absolute
 * fallback paths. Use a disposable Bun-only container, or the mount-namespace
 * masking pattern in scripts/e2e/bun-only-runtime-smoke.sh. Never remove host
 * binaries. Mount checkout/candidate read-only and output read-write. Each
 * lane resolves live npm latest; moving latest fails the final comparison.
 * Upload root-level *.json, *.jsonl, *.log and activated-launcher.sh from BOTH
 * outputs with if:always(); runtime/ retains large disposable installs locally.
 * Only --verify is aggregate PASS. Failed diagnostics are never overwritten.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";

const script = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(script), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export function settingsFixture({ workspace, plugin }) {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "synthetic-closeout-token" },
      controlUi: { enabled: false },
    },
    // Retired heartbeat fields intentionally migrate out of config in Doctor.
    // Use current scheduler policy so this is preservation proof, not migration proof.
    agents: { defaults: { workspace } },
    cron: { enabled: false },
    update: { checkOnStart: false },
    // The published updater predates the Workshop migration marker. Including
    // the plugin avoids an allowlist migration without using candidate-only config.
    plugins: {
      allow: ["closeout-owner-proof", "skill-workshop"],
      load: { paths: [plugin] },
      entries: { "closeout-owner-proof": { enabled: true }, codex: { enabled: false } },
    },
  };
}

// Permit updater bookkeeping, but every original setting must survive.
export function assertSettingsPreserved(before, actual, key = "config") {
  for (const [name, value] of Object.entries(before)) {
    const actualValue = actual?.[name];
    const message = "Changed existing setting: " + key + "." + name;
    assert(actual && Object.hasOwn(actual, name), message);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assert(
        actualValue && typeof actualValue === "object" && !Array.isArray(actualValue),
        message,
      );
      assertSettingsPreserved(value, actualValue, key + "." + name);
    } else {
      assert.deepEqual(actualValue, value, message);
    }
  }
}

export function assertIdentity(head, sha256) {
  assert.match(head ?? "", /^[a-f0-9]{40}$/, "--head must be the full candidate commit");
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/, "--sha256 must bind the supplied archive");
}
export function assertStable(version) {
  const parsed = typeof version === "string" && parseReleaseVersion(version);
  assert(
    parsed && classifyReleaseTrain(parsed) === "stable",
    "npm latest must be stable, not 9.36/extended-stable",
  );
}
export function assertUpdate(result, candidateVersion) {
  assert.equal(result.status, "ok", "Real updater must succeed");
  assert.equal(result.after?.version, candidateVersion, "Updater did not install candidate");
  assert(
    !/candidate-startup-failed|authority-check-failed|candidate-runtime-unavailable/.test(
      JSON.stringify(result),
    ),
    "Candidate validation failed or was skipped",
  );
  const steps = result.steps ?? result.run?.steps ?? [];
  for (const name of ["candidate-state-snapshot", "candidate-gateway-startup"]) {
    assert(
      steps.some((s) => (s.name ?? s.step) === name && s.exitCode === 0),
      "Successful real " + name + " step missing",
    );
  }
}
export function verifyPair(node, bun, head, sha256) {
  assertIdentity(head, sha256);
  for (const [lane, proof] of [
    ["node", node],
    ["bun", bun],
  ]) {
    assert.equal(proof.schema, 1);
    assert.equal(proof.lane, lane);
    assert.equal(proof.status, "passed", lane + " has not passed");
    assert.equal(proof.head, head);
    assert.equal(proof.candidateSha256, sha256);
    assertStable(proof.baseline.version);
    assert.equal(proof.assertions.settingsPreserved, true);
    assert.equal(proof.assertions.realUpdate, true);
  }
  assert.deepEqual(node.baseline, bun.baseline, "npm latest changed between lanes");
  assert.deepEqual(node.build, bun.build, "Lanes did not install identical build metadata");
  assert.equal(node.assertions.externalFilePrivateOwnership, true);
  assert.equal(bun.assertions.postinstallGeneratedLauncher, true);
  assert.equal(bun.assertions.nodeUnavailable, true);
  return {
    schema: 1,
    status: "passed",
    head,
    candidateSha256: sha256,
    baseline: node.baseline,
    build: node.build,
  };
}
export function observedGeneratedLayout(record) {
  if (record.localPrefix) {
    return false;
  }
  const entries = (record.path ?? "").split(path.delimiter);
  const gyp = entries.findIndex((entry) =>
    /^\.[0-9a-f]+-[0-9]+\.node-gyp$/u.test(path.basename(entry)),
  );
  const shim = entries[gyp + 1] ?? "";
  if (
    gyp < 1 ||
    !path.basename(shim).startsWith("bun-node-") ||
    entries[0] !== path.join(record.cwd, "node_modules/.bin")
  ) {
    return false;
  }
  const suffix = [];
  for (let directory = path.dirname(record.cwd); ; directory = path.dirname(directory)) {
    suffix.push(path.join(directory, "node_modules/.bin"));
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  return JSON.stringify(entries.slice(gyp + 2)) === JSON.stringify(suffix);
}
export function assertLifecycle(records, packageRoot, version) {
  const exits = records.filter(
    (r) =>
      r.event === "postinstall" &&
      r.phase === "exit" &&
      r.code === 0 &&
      r.packageVersion === version &&
      r.cwd !== packageRoot &&
      r.argv.some((arg) => arg.endsWith("/scripts/postinstall-bundled-plugins.mjs")),
  );
  assert(
    exits.some(
      (r) =>
        observedGeneratedLayout(r) &&
        r.nodes.some((n) => n.target === r.executable) &&
        r.symlink === false &&
        r.content?.startsWith("#!/bin/sh\n# OpenClaw Bun launcher\n"),
    ),
    "No actual candidate postinstall with generated Node shim produced the owned launcher",
  );
}
function jsonOutput(text) {
  const start = text.search(/^\s*[[{]/m);
  assert(start >= 0, "Command omitted JSON output");
  return JSON.parse(text.slice(start));
}

// Observer only: never modifies PATH, subprocesses, modules or lifecycle behavior.
export function lifecycleObserverSource(ledger) {
  return String.raw`import fs from "node:fs";
import path from "node:path";
const event = process.env.npm_lifecycle_event;
if (event === "preinstall" || event === "postinstall") {
  const nodes = (process.env.PATH ?? "").split(path.delimiter).flatMap(dir => {
    try { const file = path.join(dir, "node"); return [{file, target:fs.realpathSync(file)}]; } catch { return []; }
  });
  const record = {event, pid:process.pid, argv:process.argv, cwd:process.cwd(),
    bun:process.versions.bun, executable:fs.realpathSync(process.execPath),
    path:process.env.PATH, localPrefix:process.env.npm_config_local_prefix ?? null, nodes, packageVersion:null};
  try { record.packageVersion=JSON.parse(fs.readFileSync(path.join(process.cwd(),"package.json"),"utf8")).version; } catch {}
  fs.appendFileSync(__LEDGER__, JSON.stringify({...record,phase:"enter"})+"\n");
  process.on("exit", code => {
    const bin=process.env.BUN_INSTALL_BIN || path.join(process.env.BUN_INSTALL || "", "bin");
    const launcher=path.join(bin,"openclaw");
    let content=null,symlink=null;
    try { symlink=fs.lstatSync(launcher).isSymbolicLink(); if(!symlink) content=fs.readFileSync(launcher,"utf8"); } catch {}
    fs.appendFileSync(__LEDGER__, JSON.stringify({...record,phase:"exit",code,launcher,symlink,content})+"\n");
  });
}
`.replaceAll("__LEDGER__", JSON.stringify(ledger));
}

export function pluginSource({ plugin, source, state, ledger }) {
  // This fixture only writes its asset AFTER proving it is a private copy.
  return String.raw`import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const originalPlugin=__PLUGIN__, originalState=__STATE__, source=__SOURCE__, ledger=__LEDGER__;
const payload="release-closeout-external-asset\n";
function observe(surface) {
  const privateState=process.env.OPENCLAW_STATE_DIR;
  const root=path.dirname(fileURLToPath(import.meta.url));
  if (!privateState || privateState === originalState) return;
  assert(path.basename(privateState).startsWith("openclaw-update-canary-"), "Unexpected non-operator state");
  const inside=p => { const r=path.relative(privateState,p); return r!==".." && !r.startsWith(".."+path.sep) && !path.isAbsolute(r); };
  const asset=path.join(root,"config.txt"),physical=fs.realpathSync(asset);
  assert.notEqual(root,originalPlugin);
  assert(inside(fs.realpathSync(root)) && inside(physical),"External asset escaped private snapshot");
  assert.equal(fs.readFileSync(asset,"utf8"),payload);
  assert.equal(fs.readFileSync(source,"utf8"),payload);
  let count=0;
  function scan(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      assert(++count<100000,"Unexpected recursive snapshot");
      assert.notEqual(entry.name,"unrelated-broken-link","Unrelated sibling copied");
      if(entry.isDirectory()) scan(path.join(dir,entry.name));
    }
  }
  scan(privateState);
  // Exclusive marker prevents concurrent/repeated register calls mutating together.
  let owner;
  try { owner=fs.openSync(path.join(root,".ownership-proven"),"wx"); } catch(e) { if(e.code!=="EEXIST") throw e; }
  if(owner!==undefined) {
    fs.closeSync(owner);
    try {
      fs.writeFileSync(asset,"private-canary-write\n");
      assert.equal(fs.readFileSync(source,"utf8"),payload,"Private write mutated operator asset");
      assert.equal(fs.readlinkSync(path.join(originalPlugin,"config.txt")),source);
    } finally { fs.writeFileSync(asset,payload); }
  }
  fs.appendFileSync(ledger,JSON.stringify({surface,pid:process.pid,stateDir:privateState,root,physical,
    argv:process.argv,privateWriteProven:owner!==undefined,sourceUnchanged:true,unrelatedAbsent:true})+"\n");
}
export default { id:"closeout-owner-proof", register() { observe("runtime"); } };
export function normalizeCompatibilityConfig({cfg}) { observe("doctor-contract"); return {config:cfg,changes:[]}; }
`
    .replaceAll("__PLUGIN__", JSON.stringify(plugin))
    .replaceAll("__STATE__", JSON.stringify(state))
    .replaceAll("__SOURCE__", JSON.stringify(source))
    .replaceAll("__LEDGER__", JSON.stringify(ledger));
}

async function runLane(options) {
  const { head, sha256, lane: kind } = options;
  assertIdentity(head, sha256);
  assert(["node", "bun"].includes(kind), "Choose --lane node or --lane bun");
  assert.equal(process.platform, "linux", "Proof is Linux-only");
  const candidate = fs.realpathSync(options.candidate),
    out = path.resolve(options.out);
  fs.mkdirSync(out, { recursive: true });
  assert.equal(fs.readdirSync(out).length, 0, "--out must be empty (never overwrite proof)");
  const work = path.join(out, "runtime"),
    home = path.join(work, "home"),
    state = path.join(work, "state");
  // Bound only installation discovery, not the external fixture/state tree:
  // otherwise plugin dependency ownership would encompass the synthetic state.
  const prefix = path.join(work, "node_modules", "install"),
    bin = path.join(prefix, "bin"),
    tmp = path.join(work, "tmp");
  for (const dir of [home, state, bin, tmp]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_RUNTIME_DIR: path.join(work, "xdg-runtime"),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    CI: "true",
    NO_COLOR: "1",
    npm_config_cache: path.join(work, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(home, "global-npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_CEILING_DIRECTORIES: out,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  };
  for (const dir of [
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_RUNTIME_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(env.npm_config_userconfig, "registry=https://registry.npmjs.org/\n");
  fs.writeFileSync(env.npm_config_globalconfig, "");
  const proof = {
    schema: 1,
    lane: kind,
    status: "running",
    startedAt: new Date().toISOString(),
    head,
    candidateSha256: sha256,
    assertions: {},
    commands: [],
  };
  const save = () => writeJson(path.join(out, "proof.json"), proof);
  save();
  const deadline = Date.now() + 25 * 60_000;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  async function run(name, command, args, { allowFailure = false, timeout = 900000 } = {}) {
    const started = Date.now();
    const stdout = path.join(out, name + ".stdout.log");
    const stderr = path.join(out, name + ".stderr.log");
    const receipt = { name, command, args, startedAt: new Date().toISOString(), stdout, stderr };
    proof.commands.push(receipt);
    save();
    const fds = [fs.openSync(stdout, "w"), fs.openSync(stderr, "w")];
    try {
      cancellation.signal.throwIfAborted();
      assert(Date.now() < deadline, "Total proof budget exhausted");
      receipt.code = await runManagedCommand({
        bin: command,
        args,
        cwd: home,
        env,
        stdio: ["ignore", ...fds],
        timeoutMs: Math.min(timeout, deadline - Date.now()),
        timeoutKillGraceMs: 5000,
        signalKillGraceMs: 5000,
        abortKillGraceMs: 5000,
        cleanupDrainTimeoutMs: 5000,
        requireProcessTreeExit: true,
        signal: cancellation.signal,
        onSignal: (received) => {
          receipt.receivedSignal = received;
        },
      });
      receipt.processTreeState = "terminated";
      cancellation.signal.throwIfAborted();
      if (!allowFailure) {
        assert.equal(receipt.code, 0, name + " failed; see " + stderr);
      }
      return fs.readFileSync(stdout, "utf8");
    } catch (error) {
      receipt.error = String(error);
      receipt.processTreeState = hasUnjoinedWork(error) ? "unjoined" : "terminated";
      throw error;
    } finally {
      receipt.durationMs = Date.now() - started;
      fds.forEach((fd) => fs.closeSync(fd));
      save();
    }
  }
  try {
    assert.equal(hash(fs.readFileSync(candidate)), sha256, "Candidate archive checksum mismatch");
    assert.equal(
      (
        await run("checkout-head", "git", [
          "-c",
          "safe.directory=" + checkout,
          "-C",
          checkout,
          "rev-parse",
          "HEAD",
        ])
      ).trim(),
      head,
      "Script checkout differs from requested head",
    );
    const manifest = jsonOutput(
      await run("candidate-manifest", "tar", ["-xOf", candidate, "package/package.json"]),
    );
    proof.build = jsonOutput(
      await run("candidate-build", "tar", ["-xOf", candidate, "package/dist/build-info.json"]),
    );
    assert.equal(proof.build.commit, head, "Archive build-info must contain exact full head");
    assert.equal(manifest.version, proof.build.version, "Archive versions differ");
    const response = await fetch("https://registry.npmjs.org/openclaw/latest", {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, "Cannot resolve live npm latest");
    const latest = await response.json();
    assertStable(latest.version);
    assert(latest.dist?.integrity && latest.dist?.tarball, "Latest omitted package integrity");
    proof.baseline = {
      version: latest.version,
      integrity: latest.dist.integrity,
      tarball: latest.dist.tarball,
    };
    writeJson(path.join(out, "registry-latest.json"), latest);
    const plugin = path.join(work, "fixture/plugin"),
      assets = path.join(work, "fixture/assets");
    const source = path.join(assets, "config.txt"),
      ledger = path.join(out, "snapshot-observations.jsonl");
    fs.mkdirSync(plugin, { recursive: true });
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(work, "fixture/package.json"), "{}\n");
    fs.writeFileSync(source, "release-closeout-external-asset\n");
    fs.symlinkSync(
      path.join(work, "fixture/missing-unrelated-target"),
      path.join(assets, "unrelated-broken-link"),
    );
    fs.symlinkSync(source, path.join(plugin, "config.txt"));
    fs.writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "closeout-owner-proof",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    fs.writeFileSync(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "closeout-owner-proof",
        doctorContract: { configRepair: true },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    fs.writeFileSync(
      path.join(plugin, "index.mjs"),
      pluginSource({ plugin, source, state, ledger }),
    );
    fs.writeFileSync(
      path.join(plugin, "doctor-contract-api.mjs"),
      'export { normalizeCompatibilityConfig } from "./index.mjs";\n',
    );
    const config = settingsFixture({ workspace: path.join(work, "workspace"), plugin });
    fs.mkdirSync(config.agents.defaults.workspace, { recursive: true });
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    writeJson(path.join(out, "settings-before.json"), config);
    const memory = path.join(config.agents.defaults.workspace, "MEMORY.md");
    fs.writeFileSync(memory, "Synthetic existing user settings and workspace.\n");
    const memoryHash = hash(fs.readFileSync(memory));
    let packageRoot;
    if (kind === "node") {
      assert(!process.versions.bun, "Node lane must run on Node");
      env.npm_config_prefix = prefix;
      proof.runtime = {
        node: process.version,
        npm: (await run("npm-version", "npm", ["--version"])).trim(),
      };
      await run("install-latest", "npm", [
        "install",
        "-g",
        "openclaw@" + latest.version,
        "--no-audit",
        "--no-fund",
      ]);
      packageRoot = path.join(prefix, "lib/node_modules/openclaw");
    } else {
      assert(process.versions.bun, "Bun lane must run with actual Bun");
      const [major, minor, patch] = process.versions.bun.split(".").map(Number);
      assert(
        major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4))),
        "Bun >=1.4.4 required",
      );
      const nodePaths = [
        ...env.PATH.split(path.delimiter).flatMap((d) => [
          path.join(d, "node"),
          path.join(d, "nodejs"),
        ]),
        "/usr/bin/node",
        "/usr/local/bin/node",
      ];
      for (const candidateNode of new Set(nodePaths)) {
        if (fs.existsSync(candidateNode)) {
          await run("node-unavailable-" + proof.commands.length, candidateNode, ["--version"], {
            allowFailure: true,
            timeout: 10000,
          });
          assert.notEqual(
            proof.commands.at(-1).code,
            0,
            "Real Node remains reachable: " + candidateNode,
          );
        }
      }
      // Masked absolute Node sentinels must not be inherited by strict preinstall.
      // This mirrors the existing Bun-only smoke's installPath, without modifying binaries.
      env.PATH = env.PATH.split(path.delimiter)
        .map((directory, index) => {
          assert(path.isAbsolute(directory), "Bun proof requires absolute PATH entries");
          if (!["node", "nodejs"].some((name) => fs.existsSync(path.join(directory, name)))) {
            return directory;
          }
          const filtered = path.join(work, "filtered-path", String(index));
          fs.mkdirSync(filtered, { recursive: true });
          for (const name of fs.readdirSync(directory)) {
            if (name !== "node" && name !== "nodejs") {
              fs.symlinkSync(path.join(directory, name), path.join(filtered, name));
            }
          }
          return filtered;
        })
        .join(path.delimiter);
      proof.assertions.nodeUnavailable = true;
      env.BUN_INSTALL = prefix;
      env.OPENCLAW_PACKAGE_BUN_LAUNCHER = fs.realpathSync(process.execPath);
      const observer = path.join(work, "lifecycle-observer.mjs");
      fs.writeFileSync(observer, lifecycleObserverSource(path.join(out, "bun-lifecycle.jsonl")));
      env.BUN_OPTIONS = "--preload=" + observer;
      fs.mkdirSync(path.join(prefix, "install/global"), { recursive: true });
      fs.writeFileSync(
        path.join(prefix, "install/global/package.json"),
        JSON.stringify({ private: true, trustedDependencies: ["openclaw"] }),
      );
      proof.runtime = {
        bun: process.versions.bun,
        revision: (await run("bun-revision", process.execPath, ["--revision"])).trim(),
      };
      await run("install-latest", process.execPath, [
        "install",
        "-g",
        "--trust",
        "openclaw@" + latest.version,
        "--no-progress",
      ]);
      packageRoot = path.join(prefix, "install/global/node_modules/openclaw");
    }
    assert.equal(readJson(path.join(packageRoot, "package.json")).version, latest.version);
    env.PATH = bin + path.delimiter + env.PATH;
    const cli = path.join(bin, "openclaw");
    const baselineVersion = await run("baseline-version", cli, ["--version"], { timeout: 120000 });
    assert(
      baselineVersion.includes(latest.version),
      "Published CLI version does not match installed baseline",
    );
    const lifecycleOffset =
      kind === "bun" ? fs.statSync(path.join(out, "bun-lifecycle.jsonl")).size : 0;
    const result = jsonOutput(
      await run("upgrade", cli, [
        "update",
        "--tag",
        candidate,
        "--yes",
        "--no-restart",
        "--json",
        "--timeout",
        "900",
      ]),
    );
    writeJson(path.join(out, "upgrade-result.json"), result);
    assertUpdate(result, manifest.version);
    assert.equal(result.before?.version, latest.version, "Upgrade did not start from npm latest");
    const status = jsonOutput(
      await run("recorded-run", cli, ["update", "status", "--json"], { timeout: 120000 }),
    );
    writeJson(path.join(out, "recorded-run.json"), status);
    assert(status.lastRun?.runId, "Updater omitted its durable run");
    assert.equal(
      status.lastRun.runId,
      result.run?.runId ?? result.runId,
      "Status describes another update",
    );
    assert.equal(status.lastRun.phase, "finished");
    assert.equal(status.lastRun.status, "succeeded");
    proof.assertions.realUpdate = true;
    assert.deepEqual(
      readJson(path.join(packageRoot, "dist/build-info.json")),
      proof.build,
      "Installed build differs from archive",
    );
    assert.equal(readJson(path.join(packageRoot, "package.json")).version, manifest.version);
    const after = readJson(env.OPENCLAW_CONFIG_PATH);
    writeJson(path.join(out, "settings-after.json"), after);
    assertSettingsPreserved(config, after);
    assert.equal(hash(fs.readFileSync(memory)), memoryHash);
    assert.equal(fs.readFileSync(source, "utf8"), "release-closeout-external-asset\n");
    assert.equal(fs.readlinkSync(path.join(plugin, "config.txt")), source);
    proof.assertions.settingsPreserved = true;
    const observations = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
    assert(
      observations.some((o) => o.surface === "runtime" && o.argv.includes("--update-canary")),
      "Real private Gateway did not load fixture",
    );
    assert(
      observations.some((o) => o.privateWriteProven && o.sourceUnchanged && o.unrelatedAbsent),
      "No private-file ownership proof",
    );
    proof.assertions.externalFilePrivateOwnership = true;
    if (kind === "bun") {
      const lifecycle = fs
        .readFileSync(path.join(out, "bun-lifecycle.jsonl"))
        .subarray(lifecycleOffset)
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assertLifecycle(lifecycle, packageRoot, manifest.version);
      assert(!fs.lstatSync(cli).isSymbolicLink(), "Activated Bun launcher is still a symlink");
      const launcher = fs.readFileSync(cli, "utf8");
      assert(launcher.startsWith("#!/bin/sh\n# OpenClaw Bun launcher\n"));
      assert(
        launcher.includes("#openclaw-entry=" + path.join(packageRoot, "openclaw.mjs") + "\n"),
        "Launcher does not target final package",
      );
      assert(
        !fs.existsSync(path.join(packageRoot, ".openclaw-lifecycle-pending")),
        "Lifecycle incomplete",
      );
      fs.writeFileSync(path.join(out, "activated-launcher.sh"), launcher);
      proof.assertions.postinstallGeneratedLauncher = true;
    }
    const version = await run("upgraded-version", cli, ["--version"], { timeout: 120000 });
    assert(version.includes(manifest.version));
    const inspected = jsonOutput(
      await run(
        "upgraded-plugin",
        cli,
        ["plugins", "inspect", "closeout-owner-proof", "--runtime", "--json"],
        { timeout: 120000 },
      ),
    );
    assert.equal(
      inspected.plugin?.status,
      "loaded",
      "Activated package did not load the original plugin",
    );
    assert.equal(hash(fs.readFileSync(candidate)), sha256, "Input archive changed during proof");
    cancellation.signal.throwIfAborted();
    proof.status = "passed";
  } catch (error) {
    proof.status = "failed";
    proof.error = String(error);
    proof.stack = error.stack;
    throw error;
  } finally {
    proof.finishedAt = new Date().toISOString();
    save();
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
  console.log(
    JSON.stringify({ status: proof.status, lane: kind, proof: path.join(out, "proof.json") }),
  );
}
async function main() {
  const { values } = parseArgs({
    options: {
      lane: { type: "string" },
      candidate: { type: "string" },
      sha256: { type: "string" },
      head: { type: "string" },
      out: { type: "string" },
      verify: { type: "boolean" },
      "node-proof": { type: "string" },
      "bun-proof": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      fs
        .readFileSync(script, "utf8")
        .split("*/")[0]
        .replace(/^#![^\n]*\n/, "") + "*/",
    );
    return;
  }
  if (values.verify) {
    console.log(
      JSON.stringify(
        verifyPair(
          readJson(path.join(values["node-proof"], "proof.json")),
          readJson(path.join(values["bun-proof"], "proof.json")),
          values.head,
          values.sha256,
        ),
        null,
        2,
      ),
    );
    return;
  }
  assert(values.candidate && values.out, "--candidate and --out required");
  await runLane(values);
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
