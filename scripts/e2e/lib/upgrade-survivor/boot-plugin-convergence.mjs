// Real npm-plugin lifecycle proof; uses only the installed CLI and public plugin API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, write, writeJson } from "../fixtures/common.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const id = "survivor-boot-plugin";
const packageName = id;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const runtime = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const state = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(artifacts && runtime && state && configPath, "Missing isolated survivor paths");
const artifact = (name) => path.join(artifacts, `boot-plugin-${name}`);
const eventsPath = artifact("events.jsonl");
const sentinelPath = path.join(state, "boot-plugin-operator-data.txt");
const sentinel = "Existing operator data must survive the manual core swap.\n";

function cli(args, label) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  write(artifact(`${label}.out`), result.stdout ?? "");
  write(artifact(`${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed; inspect boot-plugin artifacts`);
  return result.stdout;
}

function fixture() {
  for (const stage of ["baseline", "first", "second"]) {
    for (const suffix of ["child.json", "forbidden.jsonl", "snapshot.json", "timing.json"]) {
      fs.rmSync(artifact(`${stage}-${suffix}`), { force: true });
    }
  }
  // Passive Node process diagnostics: observe real child settlement without
  // wrapping spawn, replacing node, consuming stdout, or changing any decision.
  write(
    path.join(runtime, "boot-plugin-observer.mjs"),
    `import fs from "node:fs";
import { subscribe } from "node:diagnostics_channel";
const stage = process.env.OPENCLAW_BOOT_PLUGIN_STAGE;
const root = process.env.OPENCLAW_BOOT_PLUGIN_PACKAGE_ROOT;
subscribe("child_process", ({ process: child }) => {
  const argv = child.spawnargs;
  if (!stage || !root || !argv.some((arg) => arg.startsWith(root + "/"))) return;
  const prefix = ${JSON.stringify(artifact(""))} + stage;
  if (argv.includes("doctor") || argv.includes("--update-canary")) {
    fs.appendFileSync(prefix + "-forbidden.jsonl", JSON.stringify({ argv }) + "\\n");
  }
  if (!argv.includes("update") || !argv.includes("plugins") || !argv.includes("--json")) return;
  const observedStartAtMs = Date.now();
  const started = process.hrtime.bigint();
  child.once("close", (exitCode, signal) => {
    fs.writeFileSync(prefix + "-child.json.tmp", JSON.stringify({
      pid: child.pid, argv, exitCode, signal, observedStartAtMs,
      observedExitAtMs: Date.now(),
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    }));
    fs.renameSync(prefix + "-child.json.tmp", prefix + "-child.json");
  });
});
`,
  );
  for (const version of ["1.0.0", "2.0.0"]) {
    const directory = path.join(runtime, "boot-plugin-packages", version);
    writeJson(path.join(directory, "package.json"), {
      name: packageName,
      version,
      type: "module",
      files: ["index.mjs", "openclaw.plugin.json"],
      openclaw: { extensions: ["./index.mjs"] },
    });
    writeJson(path.join(directory, "openclaw.plugin.json"), {
      id,
      name: "Survivor boot plugin",
      activation: { onStartup: true },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { greeting: { type: "string" } },
      },
    });
    write(
      path.join(directory, "index.mjs"),
      `import fs from "node:fs";
export default {
  id: ${JSON.stringify(id)},
  register(api) {
    api.registerGatewayMethod("survivor.boot.version", ({ respond }) => {
      respond(true, { version: ${JSON.stringify(version)}, greeting: api.pluginConfig?.greeting });
    }, { scope: "operator.read" });
    api.registerService({
      id: ${JSON.stringify(id)},
      start() {
        fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({
          version: ${JSON.stringify(version)}, atMs: Date.now(), pid: process.pid,
          stateDir: process.env.OPENCLAW_STATE_DIR, argv: process.argv.slice(2),
        }) + "\\n");
      },
      stop() {},
    });
  },
};
`,
    );
  }
  write(eventsPath, "");
  write(sentinelPath, sentinel);
  writeJson(configPath, {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: process.env.GATEWAY_AUTH_TOKEN_REF },
      controlUi: { enabled: false },
    },
    agents: { defaults: { workspace: path.join(state, "workspace") } },
  });
}

function snapshot() {
  assert(
    !fs.existsSync(path.join(state, "git-install", "releases", ".trial")),
    "Proof must not use an update trial",
  );
  const record = readPluginInstallRecords()[id];
  assert.equal(record?.source, "npm", "Plugin must be installed by the real npm installer");
  assert.equal(record.resolvedName, packageName);
  assert(record.installPath, "Installed plugin omitted its path");
  const files = {};
  function visit(relative) {
    const file = path.join(record.installPath, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(relative, name));
      }
    } else {
      files[relative] = {
        mode: stat.mode,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256")
          .update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file))
          .digest("hex"),
      };
    }
  }
  visit("");
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), sentinel);
  return { config: fs.readFileSync(configPath, "utf8"), record, files };
}

async function observe(stage, version, startedAt, readyAt) {
  const deadline = Date.now() + 300_000;
  let activation;
  let completedAt;
  while (Date.now() < deadline) {
    const events = fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    activation = events.find(
      (event) => event.version === version && event.atMs >= startedAt && event.stateDir === state,
    );
    if (activation && (stage === "baseline" || fs.existsSync(artifact(`${stage}-child.json`)))) {
      completedAt =
        stage === "baseline"
          ? activation.atMs
          : Math.max(activation.atMs, readJson(artifact(`${stage}-child.json`)).observedExitAtMs);
      break;
    }
    await delay(100);
  }
  assert(
    completedAt && activation,
    `${stage}: timed out awaiting runtime v${version} and boot convergence completion`,
  );
  assert(activation.argv.includes("gateway"), "Plugin was not activated by the real Gateway");
  assert(!activation.argv.includes("--update-canary"), "A trial cannot prove boot convergence");
  const help = cli(["gateway", "call", "--help"], `${stage}-rpc-help`);
  const url = "ws://127.0.0.1:18789";
  const address = help.includes("--expect-url")
    ? ["--expect-url", url]
    : ["--url", url, "--token", process.env.GATEWAY_AUTH_TOKEN_REF];
  const output = cli(
    ["gateway", "call", "survivor.boot.version", ...address, "--params", "{}", "--json"],
    `${stage}-rpc`,
  );
  const reply = JSON.parse(output.slice(output.search(/^\s*\{/mu)));
  assert.deepEqual(reply, { version, greeting: "Preserved operator setting" });
  const installed = snapshot();
  assert.equal(installed.record.resolvedVersion, version);
  if (stage === "second") {
    assert.deepEqual(
      installed,
      readJson(artifact("first-snapshot.json")),
      "Unchanged boot rewrote plugin config, install metadata, or package files",
    );
  }
  writeJson(artifact(`${stage}-snapshot.json`), installed);
  let child;
  let registryChecks = [];
  if (stage !== "baseline") {
    child = readJson(artifact(`${stage}-child.json`));
    assert.equal(child.exitCode, 0, "Boot plugin update child failed");
    assert.equal(child.signal, null, "Boot plugin update child was signalled");
    assert(!fs.existsSync(artifact(`${stage}-forbidden.jsonl`)), "Boot ran Doctor or a trial");
    assert(child.observedStartAtMs >= startedAt, "Convergence receipt belongs to an earlier boot");
    registryChecks = fs
      .readFileSync(artifact("registry.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.atMs >= startedAt &&
          entry.statusCode === 200 &&
          decodeURIComponent(entry.path).startsWith(`/${packageName}`) &&
          !entry.path.includes("/-/"),
      );
    assert(registryChecks.length > 0, "Boot child did not check the real plugin registry");
  }
  const receipt = {
    stage,
    version,
    startedAtMs: startedAt,
    readyAtMs: readyAt,
    runtimeActivatedAtMs: activation.atMs,
    convergenceObservedAtMs: completedAt,
    timeToReadyMs: readyAt - startedAt,
    timeToConvergedMs: completedAt - startedAt,
    afterReadyConvergenceMs: Math.max(0, completedAt - readyAt),
    pollingIntervalMs: 100,
    child,
    childDurationMs: child?.durationMs ?? null,
    registryChecks,
    noDrift: stage === "second" ? true : null,
  };
  writeJson(artifact(`${stage}-timing.json`), receipt);
  console.log(JSON.stringify(receipt));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "fixture") {
  fixture();
} else if (mode === "configure") {
  const config = readJson(configPath);
  config.plugins ??= {};
  config.plugins.allow = [id];
  config.plugins.entries ??= {};
  config.plugins.entries[id] = {
    enabled: true,
    config: { greeting: "Preserved operator setting" },
  };
  writeJson(configPath, config);
} else if (mode === "observe") {
  const [stage, version, startedAt, readyAt] = args;
  await observe(stage, version, Number(startedAt), Number(readyAt));
} else if (mode === "assert-preboot") {
  assert.equal(
    snapshot().record.resolvedVersion,
    "1.0.0",
    "Core installation updated the plugin before boot",
  );
} else {
  throw new Error(`Unknown boot plugin fixture mode: ${mode}`);
}
