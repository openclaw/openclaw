// Real npm-plugin lifecycle proof; uses only the installed CLI and public plugin API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
          version: ${JSON.stringify(version)},
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

function assertInstalledVersion(version) {
  assert(
    !fs.existsSync(path.join(state, "git-install", "releases", ".trial")),
    "Proof must not use an update trial",
  );
  const record = readPluginInstallRecords()[id];
  assert.equal(record?.source, "npm", "Plugin must be installed by the real npm installer");
  assert.equal(record.resolvedName, packageName);
  assert.equal(record.resolvedVersion, version);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), sentinel);
}

async function observe(stage, version) {
  const deadline = Date.now() + 300_000;
  let activation;
  while (Date.now() < deadline) {
    const events = fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    activation = events.find((event) => event.version === version && event.stateDir === state);
    if (activation) {
      break;
    }
    await delay(100);
  }
  assert(activation, `${stage}: timed out awaiting live plugin v${version}`);
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
  assertInstalledVersion(version);
  console.log(`${stage}: live plugin v${version} served; operator data preserved.`);
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
  const [stage, version] = args;
  await observe(stage, version);
} else if (mode === "assert-preboot") {
  assertInstalledVersion("1.0.0");
} else {
  throw new Error(`Unknown boot plugin fixture mode: ${mode}`);
}
