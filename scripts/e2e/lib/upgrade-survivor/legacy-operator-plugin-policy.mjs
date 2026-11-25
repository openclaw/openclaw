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
  assert(
    specimen.model?.startsWith("survivor/") && specimen.provider,
    "missing survivor mock route",
  );
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
    models: { providers: { survivor: specimen.provider } },
    agents: {
      defaults: {
        workspace: path.join(process.env.OPENCLAW_STATE_DIR, "workspace"),
        model: { primary: specimen.model },
      },
    },
    plugins: {
      allow: ["webhooks"],
      deny: ["webhooks", "device-pair"],
      slots: { memory: "memory-core" },
      entries: { webhooks: specimen.entry },
    },
    channels: { telegram: { enabled: true } },
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
  assert.deepEqual(authored.channels, expected.channels);
  assert.deepEqual(authored.models, expected.models);
  assert.equal(authored.agents?.defaults?.model?.primary, specimen.model);
  cli(["config", "validate", "--json"], "baseline-validation");
  writeJson(artifact("specimen.json"), {
    baselineVersion,
    plugins: authored.plugins,
    channels: authored.channels,
    hooks: authored.hooks,
  });
}

export function assertSolePluginPolicy(config, specimen, baseline) {
  assert.notEqual(
    config.plugins?.enabled,
    false,
    "retirement disabled permitted channel or slot plugins",
  );
  // Selected slots and configured bundled channels can bypass this list; the
  // Gateway inventory comparison below owns equality of effective eligibility.
  const allow = config.plugins?.allow;
  assert(
    Array.isArray(allow) &&
      allow.length > 0 &&
      allow.every((id) => baseline.enabledPlugins.includes(id)),
    "retirement widened or removed the restrictive plugin allowlist",
  );
  assert.equal(config.plugins?.entries?.webhooks, undefined, "retired plugin entry remains");
  assert(!config.plugins?.allow?.includes("webhooks"), "retired allow reference remains");
  assert(!config.plugins?.deny?.includes("webhooks"), "retired deny reference remains");
  assert(config.plugins?.deny?.includes("device-pair"), "unrelated plugin denial was removed");
  assert.equal(
    config.channels?.telegram?.enabled,
    true,
    "configured Telegram channel was disabled",
  );
  assert.equal(
    config.plugins?.slots?.memory,
    specimen.plugins.slots.memory,
    "selected memory slot changed",
  );
  assert.deepEqual(config.hooks, specimen.hooks, "ordinary hooks changed in the sole-policy probe");
}

export function readEnabledPolicyPlugins(inventory) {
  assert(Array.isArray(inventory.plugins), "Gateway omitted plugin inventory");
  for (const id of ["telegram", "memory-core", "device-pair"]) {
    const records = inventory.plugins.filter((plugin) => plugin.id === id);
    assert.equal(records.length, 1, `Gateway omitted or duplicated installed plugin ${id}`);
    assert.equal(records[0].installed, true, `policy plugin ${id} is not installed`);
    assert.equal(
      records[0].enabled,
      id !== "device-pair",
      `plugin ${id} has the wrong activation policy`,
    );
  }
  const enabled = inventory.plugins
    .filter((plugin) => plugin.enabled === true)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert(
    enabled.every((id) => typeof id === "string" && id.length > 0),
    "invalid enabled plugin identity",
  );
  assert.equal(new Set(enabled).size, enabled.length, "ambiguous enabled plugin inventory");
  assert(!enabled.includes("webhooks"), "denied Webhooks plugin was enabled");
  return enabled;
}

export function assertPreservedPluginActivation(inventory, baseline) {
  assert.deepEqual(
    readEnabledPolicyPlugins(inventory),
    baseline.enabledPlugins,
    "candidate widened or lost plugin activation",
  );
  assert(
    !inventory.plugins.some((plugin) => plugin.id === "webhooks"),
    "candidate still discovers Webhooks",
  );
  const active = [];
  for (const plugin of inventory.plugins) {
    assert(
      ["active", "disabled", "unloaded"].includes(plugin.runtime?.state),
      `candidate plugin runtime failed or is unknown: ${plugin.id}`,
    );
    if (plugin.runtime.state === "active") {
      assert(
        baseline.enabledPlugins.includes(plugin.id),
        `candidate activated forbidden plugin ${plugin.id}`,
      );
      active.push(plugin.id);
    }
  }
  return active.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function gatewayInventory(label) {
  return cliJson(
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
    label,
  );
}

async function run(mode, expectedVersion) {
  const specimen = readJson(artifact("specimen.json"));
  assert.equal(
    installedVersion(),
    expectedVersion,
    "isolated update installed a different candidate",
  );
  const config = readJson(process.env.OPENCLAW_CONFIG_PATH);
  if (mode === "baseline") {
    assert.equal(expectedVersion, specimen.baselineVersion);
    assert.deepEqual(
      config.plugins,
      specimen.plugins,
      "baseline policy changed before observation",
    );
    // The published 9.2 RPC exposes policy eligibility; runtime.state is a later addition.
    const enabledPlugins = readEnabledPolicyPlugins(gatewayInventory("baseline-runtime"));
    writeJson(artifact("baseline-activation.json"), {
      baselineVersion: expectedVersion,
      enabledPlugins,
    });
    return;
  }
  const baseline = readJson(artifact("baseline-activation.json"));
  assert.equal(baseline.baselineVersion, specimen.baselineVersion);
  assertSolePluginPolicy(config, specimen, baseline);
  const validation = cliJson(["config", "validate", "--json"], `${mode}-validation`);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.warnings, []);
  if (mode === "live") {
    const inventory = gatewayInventory("candidate-runtime");
    const activePlugins = assertPreservedPluginActivation(inventory, baseline);
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
      baselineEnabledPlugins: baseline.enabledPlugins,
      candidateEnabledPlugins: readEnabledPolicyPlugins(inventory),
      activePlugins,
      configuredChannelPlugin: "telegram",
      selectedMemoryPlugin: "memory-core",
      deniedPlugins: ["device-pair"],
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
      ["baseline", "post-update", "live"].includes(mode) && args.length === 1,
      "invalid policy proof mode",
    );
    await run(mode, args[0]);
  }
}
