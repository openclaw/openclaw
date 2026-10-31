// Packaged upgrade proof; this helper never imports candidate product source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedResponseText } from "../../../lib/bounded-response.mjs";
import { readJson, write, writeJson } from "../fixtures/common.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const PLUGIN_ID = "openclaw-survivor-native-ui";
const PACKAGE_NAME = PLUGIN_ID;
const SETTINGS = { label: "Existing operator setting", retained: 177869 };
const DATA = "Existing native plugin operator data.\n";
const BROWSER_ASSETS = {
  "index.js": `export default { id: "openclaw-survivor-native-ui", activate() {} };\n`,
  "style.css": ".survivor-native-ui { color: rgb(17, 78, 69); }\n",
};
const MANIFEST = {
  id: PLUGIN_ID,
  name: "Survivor native UI",
  activation: { onStartup: true },
  controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/style.css"] },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string" }, retained: { type: "number" } },
  },
};

function required(name) {
  assert(process.env[name], `Missing isolated proof path: ${name}`);
  return process.env[name];
}
const artifact = (name) => path.join(required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const config = () => readJson(required("OPENCLAW_CONFIG_PATH"));
const dataPath = () =>
  path.join(required("OPENCLAW_STATE_DIR"), "native-ui-proof", "operator-data.txt");

function cli(args, label, json = false) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  write(artifact(`native-ui-${label}.out`), result.stdout ?? "");
  write(artifact(`native-ui-${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed; inspect native UI scenario artifacts`);
  if (!json) {
    return result.stdout;
  }
  const start = result.stdout.search(/^\s*\{/mu);
  assert(start >= 0, `${label} omitted its JSON result`);
  return JSON.parse(result.stdout.slice(start));
}

function writeNativeUiFixture(directory) {
  writeJson(path.join(directory, "package.json"), {
    name: PACKAGE_NAME,
    version: "1.0.0",
    type: "module",
    files: ["index.mjs", "openclaw.plugin.json", "dist"],
    openclaw: { extensions: ["./index.mjs"] },
  });
  writeJson(path.join(directory, "openclaw.plugin.json"), MANIFEST);
  write(
    path.join(directory, "index.mjs"),
    `export default { id: "${PLUGIN_ID}", register() {} };\n`,
  );
  for (const [name, bytes] of Object.entries(BROWSER_ASSETS)) {
    write(path.join(directory, "dist/control-ui", name), bytes);
  }
}

function configure(policy) {
  assert(["omitted", "false"].includes(policy));
  const set = (key, value) =>
    cli(["config", "set", key, JSON.stringify(value), "--strict-json"], key);
  if (policy === "false") {
    set("gateway", {
      mode: "local",
      bind: "loopback",
      port: 18789,
      reload: { mode: "off" },
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
      },
      controlUi: { enabled: true, experimental: { customPlugins: false } },
    });
    set("agents.defaults.workspace", path.join(required("OPENCLAW_STATE_DIR"), "workspace"));
  } else {
    assert.equal(
      Object.hasOwn(config().gateway?.controlUi?.experimental ?? {}, "customPlugins"),
      false,
      "Omitted-policy specimen already has a customPlugins override",
    );
    set("gateway.controlUi.enabled", true);
  }
  const plugins = config().plugins ?? {};
  set("plugins", {
    ...plugins,
    ...(plugins.allow ? { allow: [...new Set([...plugins.allow, PLUGIN_ID])] } : {}),
    entries: {
      ...plugins.entries,
      [PLUGIN_ID]: { ...plugins.entries?.[PLUGIN_ID], enabled: true, config: SETTINGS },
    },
  });
  write(dataPath(), DATA);
  cli(["config", "validate", "--json"], "baseline-config-validation");
}

function installedFiles() {
  const records = readPluginInstallRecords();
  const installed = records[PACKAGE_NAME];
  assert.equal(installed?.source, "npm", "Native UI fixture was not installed through managed npm");
  assert.equal(installed.version, "1.0.0");
  assert(installed.installPath, "Native UI install record omitted its managed package path");
  const packageRoot = fs.realpathSync(installed.installPath);
  assert.equal(path.basename(packageRoot), PACKAGE_NAME);
  assert.equal(
    path.basename(path.dirname(packageRoot)),
    "node_modules",
    "Fixture is a raw source copy",
  );
  const projectRoot = path.dirname(path.dirname(packageRoot));
  const dependency = readJson(path.join(projectRoot, "package.json")).dependencies?.[PACKAGE_NAME];
  assert.equal(dependency, "1.0.0", "Managed npm project lost its exact fixture dependency");
  const archive = fs.readFileSync(artifact("native-ui-fixture.tgz"));
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(
    installed.integrity,
    integrity,
    "Install provenance differs from the fixture registry archive",
  );
  const lock = readJson(path.join(projectRoot, "package-lock.json"));
  assert.equal(
    lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity,
    integrity,
    "Managed npm lockfile differs from the installed fixture archive",
  );
  const manifest = readJson(path.join(packageRoot, "openclaw.plugin.json"));
  assert.deepEqual(
    manifest.controlUi,
    MANIFEST.controlUi,
    "Fixture has no declared native browser entry",
  );
  const files = Object.fromEntries(
    [
      "index.mjs",
      "openclaw.plugin.json",
      ...Object.keys(BROWSER_ASSETS).map((name) => `dist/control-ui/${name}`),
    ].map((name) => [name, hash(fs.readFileSync(path.join(packageRoot, name)))]),
  );
  return { packageRoot, files, archiveSha256: hash(archive) };
}

function assertNativeUiPolicy(configValue, policy) {
  const experimental = configValue.gateway?.controlUi?.experimental ?? {};
  if (policy === "omitted") {
    assert.equal(
      Object.hasOwn(experimental, "customPlugins"),
      false,
      "Upgrade inserted a native UI policy override",
    );
  } else {
    assert.equal(experimental.customPlugins, false, "Upgrade lost the explicit native UI opt-out");
  }
  assert.equal(configValue.gateway?.controlUi?.enabled, true, "Upgrade disabled the Control UI");
  assert.equal(
    configValue.plugins?.entries?.[PLUGIN_ID]?.enabled,
    true,
    "Upgrade disabled the native plugin",
  );
  assert.deepEqual(
    configValue.plugins.entries[PLUGIN_ID].config,
    SETTINGS,
    "Upgrade changed native plugin settings",
  );
}

function assertNativeUiCatalog(catalog, enabled) {
  assert(
    Array.isArray(catalog.plugins) && Array.isArray(catalog.diagnostics),
    "Gateway omitted native UI catalog",
  );
  const modules = catalog.plugins.filter((entry) => entry.pluginId === PLUGIN_ID);
  const diagnostics = catalog.diagnostics.filter((entry) => entry.pluginId === PLUGIN_ID);
  if (!enabled) {
    assert.equal(modules.length, 0, "Opted-out native UI was advertised");
    assert(
      diagnostics.some((entry) => entry.code === "custom-plugin-ui-disabled"),
      "Missing native UI policy diagnostic",
    );
    return undefined;
  }
  assert.equal(
    modules.length,
    1,
    "Omitted-policy upgrade did not make the existing native UI eligible",
  );
  assert.deepEqual(diagnostics, [], "Native UI upgrade has an asset or policy diagnostic");
  const module = modules[0];
  assert.match(module.revision, /^[a-f0-9]{64}$/u);
  const prefix = `/__openclaw__/plugins/control-ui/${PLUGIN_ID}/${module.revision}/`;
  assert.equal(module.entryUrl, `${prefix}index.js`);
  assert.deepEqual(module.styles, [`${prefix}style.css`]);
  return module;
}

let gatewayAddressArgs;
function rpc(method, label) {
  if (!gatewayAddressArgs) {
    const help = cli(["gateway", "call", "--help"], "gateway-call-help");
    const url = "ws://127.0.0.1:18789";
    gatewayAddressArgs = help.includes("--expect-url")
      ? ["--expect-url", url]
      : ["--url", url, "--token", required("GATEWAY_AUTH_TOKEN_REF")];
  }
  return cli(
    ["gateway", "call", method, ...gatewayAddressArgs, "--params", "{}", "--json"],
    label,
    true,
  );
}

async function asset(url, authenticated) {
  assert(
    url.startsWith(`/__openclaw__/plugins/control-ui/${PLUGIN_ID}/`),
    "Unexpected fixture asset path",
  );
  const response = await fetch(new URL(url, "http://127.0.0.1:18789"), {
    headers: authenticated ? { Authorization: `Bearer ${required("GATEWAY_AUTH_TOKEN_REF")}` } : {},
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const body = await readBoundedResponseText(response, "native UI asset", 16 * 1024);
  return {
    url,
    authenticated,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
  };
}

async function probe(stage, policy, expectedVersion, allowedModuleFile) {
  assertNativeUiPolicy(config(), policy);
  const installed = installedFiles();
  const baselineFile = artifact("native-ui-baseline-files.json");
  if (stage === "baseline") {
    writeJson(baselineFile, installed);
  } else {
    const baseline = readJson(baselineFile);
    assert.deepEqual(
      installed.files,
      baseline.files,
      "Upgrade changed the installed native plugin files",
    );
    assert.equal(
      installed.archiveSha256,
      baseline.archiveSha256,
      "Upgrade changed the native plugin archive",
    );
  }
  assert.equal(
    fs.readFileSync(dataPath(), "utf8"),
    DATA,
    "Upgrade changed the native UI state-directory sentinel",
  );
  // Prove the serving package, not merely the CLI executable on PATH.
  const status = cli(
    [
      "gateway",
      "status",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      required("GATEWAY_AUTH_TOKEN_REF"),
      "--require-rpc",
      "--timeout",
      "30000",
      "--json",
    ],
    `${stage}-status`,
    true,
  );
  assert.equal(
    status.gateway?.version,
    expectedVersion,
    "Native UI probe reached the wrong Gateway version",
  );
  const inventory = rpc("plugins.list", `${stage}-plugins`);
  const plugin = inventory.plugins?.find((entry) => entry.id === PLUGIN_ID);
  assert.equal(plugin?.enabled, true, "Gateway did not retain the enabled native plugin");
  assert.equal(
    plugin.runtime?.state,
    "active",
    "Gateway did not load the enabled native plugin backend",
  );
  assert(
    typeof plugin.origin === "string" && plugin.origin !== "bundled",
    "Fixture must remain a user-installed plugin",
  );
  const catalog = rpc("plugins.controlUi.list", `${stage}-catalog`);
  const enabled = stage === "candidate" && policy === "omitted";
  const module = assertNativeUiCatalog(catalog, enabled);
  const responses = [];
  if (enabled) {
    writeJson(artifact("native-ui-allowed-module.json"), module);
    for (const [index, url] of [module.entryUrl, ...module.styles].entries()) {
      const response = await asset(url, true);
      assert.equal(response.status, 200, "Eligible native UI asset was not served");
      assert.equal(
        response.body,
        Object.values(BROWSER_ASSETS)[index],
        "Native UI asset bytes changed",
      );
      assert.match(response.contentType ?? "", index === 0 ? /javascript/u : /text\/css/u);
      responses.push({ ...response, body: undefined, sha256: hash(response.body) });
    }
    const denied = await asset(module.entryUrl, false);
    assert.equal(denied.status, 401, "Native UI assets became unauthenticated");
    responses.push({ ...denied, body: undefined });
  } else if (allowedModuleFile) {
    const allowed = readJson(allowedModuleFile);
    for (const url of [allowed.entryUrl, ...allowed.styles]) {
      const denied = await asset(url, true);
      assert.equal(denied.status, 404, "Explicit opt-out still served native UI assets");
      responses.push({ ...denied, body: undefined });
    }
  }
  writeJson(artifact(`native-ui-${stage}-proof.json`), {
    status: "passed",
    stage,
    policy,
    expectedVersion,
    servingVersion: status.gateway.version,
    plugin,
    installed,
    eligible: enabled,
    catalog,
    assets: responses,
    pluginSettingsPreserved: true,
    operatorDataPreserved: true,
    ...(stage === "candidate"
      ? { baseline: readJson(artifact("native-ui-baseline-proof.json")) }
      : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "fixture") {
    writeNativeUiFixture(args[0]);
  } else if (mode === "configure") {
    configure(args[0]);
  } else if (mode === "probe") {
    await probe(...args);
  } else {
    throw new Error(`Unknown native UI proof mode: ${mode}`);
  }
}
