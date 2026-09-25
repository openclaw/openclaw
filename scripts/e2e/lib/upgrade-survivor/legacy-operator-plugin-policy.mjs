import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const artifact = (name) => path.join(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, name);
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function installedVersion() {
  const root = path.join(process.env.npm_config_prefix, "lib/node_modules/openclaw");
  const entry = fs.realpathSync(path.join(process.env.npm_config_prefix, "bin/openclaw"));
  const relative = path.relative(fs.realpathSync(root), entry);
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "policy CLI escaped its isolated installation",
  );
  const manifest = readJson(path.join(root, "package.json"));
  assert.equal(manifest.name, "openclaw");
  return manifest.version;
}

function cli(args, label) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  fs.writeFileSync(artifact(`${label}.out`), result.stdout ?? "");
  fs.writeFileSync(artifact(`${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed; see isolated policy artifacts`);
  return result.stdout;
}

function cliJson(args, label) {
  const text = cli(args, label);
  const start = text.search(/^\s*\{/mu);
  assert(start >= 0, `${label} did not return JSON`);
  return JSON.parse(text.slice(start));
}

function seedSolePluginPolicy(sourceArtifacts, baselineVersion) {
  const specimen = readJson(path.join(sourceArtifacts, "legacy-operator-webhooks.json"));
  assert.equal(specimen.seeded, true, "sole-plugin policy requires the baseline Webhooks specimen");
  assert.equal(specimen.baselineVersion, baselineVersion);
  assert.equal(installedVersion(), baselineVersion, "policy author is not the published baseline");
  const expected = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      reload: { mode: "off" },
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
      },
    },
    agents: { defaults: { workspace: path.join(process.env.OPENCLAW_STATE_DIR, "workspace") } },
    plugins: { allow: ["webhooks"], deny: ["webhooks"], entries: { webhooks: specimen.entry } },
    hooks: specimen.hooks,
  };
  for (const [key, value] of Object.entries(expected)) {
    cli(["config", "set", key, JSON.stringify(value), "--strict-json"], `baseline-${key}`);
  }
  const authored = readJson(process.env.OPENCLAW_CONFIG_PATH);
  assert.deepEqual(
    authored.plugins,
    expected.plugins,
    "published CLI changed sole allowlist input",
  );
  assert.deepEqual(authored.hooks, expected.hooks);
  cli(["config", "validate", "--json"], "baseline-validation");
  writeJson(artifact("specimen.json"), {
    baselineVersion,
    plugins: authored.plugins,
    hooks: authored.hooks,
  });
}

export function assertSolePluginPolicy(config, specimen) {
  assert.equal(
    config.plugins?.enabled,
    false,
    "retiring the sole allowed plugin enabled other plugins",
  );
  assert.equal(config.plugins?.entries?.webhooks, undefined, "retired plugin entry remains");
  assert(!config.plugins?.allow?.includes("webhooks"), "retired allow reference remains");
  assert(!config.plugins?.deny?.includes("webhooks"), "retired deny reference remains");
  assert.deepEqual(config.hooks, specimen.hooks, "ordinary hooks changed in the sole-policy probe");
}

export function assertInactivePluginRuntimes(inventory) {
  assert(Array.isArray(inventory.plugins), "candidate Gateway omitted plugin runtime inventory");
  assert(
    inventory.plugins.some((plugin) => plugin.id === "device-pair"),
    "candidate inventory lacks surviving plugin",
  );
  assert(
    !inventory.plugins.some((plugin) => plugin.id === "webhooks"),
    "candidate still discovers Webhooks",
  );
  for (const plugin of inventory.plugins) {
    assert(
      ["disabled", "unloaded"].includes(plugin.runtime?.state),
      `candidate activated plugin ${plugin.id}`,
    );
  }
}

async function run(mode, expectedVersion) {
  const specimen = readJson(artifact("specimen.json"));
  assert.equal(
    installedVersion(),
    expectedVersion,
    "isolated update installed a different candidate",
  );
  const config = readJson(process.env.OPENCLAW_CONFIG_PATH);
  assertSolePluginPolicy(config, specimen);
  const validation = cliJson(["config", "validate", "--json"], `${mode}-validation`);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.warnings, []);
  if (mode === "live") {
    const inventory = cliJson(
      [
        "gateway",
        "call",
        "plugins.list",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        process.env.GATEWAY_AUTH_TOKEN_REF,
        "--params",
        "{}",
        "--json",
      ],
      "candidate-runtime",
    );
    assertInactivePluginRuntimes(inventory);
    // Unauthorized hook traffic proves the preserved core route without scheduling a turn.
    const response = await fetch(`http://127.0.0.1:18789${specimen.hooks.path}/wake`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    assert.equal(response.status, 401, "ordinary hooks no longer enforce their auth boundary");
    writeJson(artifact("result.json"), {
      baselineVersion: specimen.baselineVersion,
      candidateVersion: expectedVersion,
      oldAllowlist: specimen.plugins.allow,
      pluginsDisabled: true,
      activePlugins: [],
      ordinaryHooksPreserved: true,
      hooksSha256: digest(config.hooks),
      hookUnauthorizedStatus: response.status,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "seed" && args.length === 2) {
    seedSolePluginPolicy(...args);
  } else if (mode === "driver" && args.length === 1) {
    assert.equal(installedVersion(), args[0]);
  } else {
    assert(
      ["post-update", "live"].includes(mode) && args.length === 1,
      "invalid policy proof mode",
    );
    await run(mode, args[0]);
  }
}
