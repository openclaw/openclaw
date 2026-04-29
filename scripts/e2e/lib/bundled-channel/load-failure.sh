#!/usr/bin/env bash
#
# Runs load-failure isolation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_load_failure_scenario() {
  local state_script_b64
  state_script_b64="$(docker_e2e_test_state_shell_b64 bundled-channel-load-failure empty)"

  echo "Running bundled channel load-failure isolation Docker E2E..."
  run_logged_print bundled-channel-load-failure timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$state_script_b64" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    "${DOCKER_E2E_HARNESS_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-load-failure-install.log 2>&1

root="$(bundled_channel_package_root)"
plugin_dir="$root/dist/extensions/load-failure-alpha"
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{
  "name": "@openclaw/load-failure-alpha",
  "version": "2026.4.21",
  "private": true,
  "type": "module",
  "openclaw": {
    "extensions": ["./index.js"],
    "setupEntry": "./setup-entry.js"
  }
}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "load-failure-alpha",
  "channels": ["load-failure-alpha"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
JSON
cat >"$plugin_dir/index.js" <<'JS'
export default {
  kind: "bundled-channel-entry",
  id: "load-failure-alpha",
  name: "Load Failure Alpha",
  description: "Load Failure Alpha",
  register() {},
  loadChannelSecrets() {
    globalThis.__loadFailureSecrets = (globalThis.__loadFailureSecrets ?? 0) + 1;
    throw new Error("synthetic channel secrets failure");
  },
  loadChannelPlugin() {
    globalThis.__loadFailurePlugin = (globalThis.__loadFailurePlugin ?? 0) + 1;
    throw new Error("synthetic channel plugin failure");
  }
};
JS
cat >"$plugin_dir/setup-entry.js" <<'JS'
export default {
  kind: "bundled-channel-setup-entry",
  loadSetupSecrets() {
    globalThis.__loadFailureSetupSecrets = (globalThis.__loadFailureSetupSecrets ?? 0) + 1;
    throw new Error("synthetic setup secrets failure");
  },
  loadSetupPlugin() {
    globalThis.__loadFailureSetup = (globalThis.__loadFailureSetup ?? 0) + 1;
    throw new Error("synthetic setup plugin failure");
  }
};
JS

echo "Loading synthetic failing bundled channel through packaged loader..."
(
  cd "$root"
  OPENCLAW_BUNDLED_PLUGINS_DIR="$root/dist/extensions" node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distDir = path.join(root, "dist");
const bundledPath = fs
  .readdirSync(distDir)
  .filter((entry) => /^bundled-[A-Za-z0-9_-]+\.js$/.test(entry))
  .map((entry) => path.join(distDir, entry))
  .find((entry) => fs.readFileSync(entry, "utf8").includes("src/channels/plugins/bundled.ts"));
if (!bundledPath) {
  throw new Error("missing packaged bundled channel loader artifact");
}
const bundled = await import(pathToFileURL(bundledPath));
const loaderNames = [
  "getBundledChannelPlugin",
  "getBundledChannelSetupPlugin",
  "getBundledChannelSecrets",
  "getBundledChannelSetupSecrets",
];
const exportedLoaders = new Map(
  Object.values(bundled)
    .filter((value) => typeof value === "function")
    .map((fn) => [fn.name, fn]),
);
const loaders = loaderNames.map((name) => {
  const fn = exportedLoaders.get(name);
  if (typeof fn !== "function") {
    throw new Error(`missing packaged bundled loader export ${name}; exports=${Object.keys(bundled).join(",")}`);
  }
  return [name, fn];
});

const id = "load-failure-alpha";
function exerciseLoaders() {
  for (const [name, fn] of loaders) {
    try {
      fn(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("synthetic")) {
        throw new Error(`bundled export ${name} leaked synthetic load failure: ${message}`);
      }
    }
  }
}

function loadCounts() {
  return {
    plugin: globalThis.__loadFailurePlugin,
    setup: globalThis.__loadFailureSetup,
    secrets: globalThis.__loadFailureSecrets,
    setupSecrets: globalThis.__loadFailureSetupSecrets,
  };
}

exerciseLoaders();
const firstCounts = loadCounts();
exerciseLoaders();
const secondCounts = loadCounts();
for (const key of ["plugin", "setup", "setupSecrets"]) {
  const first = firstCounts[key];
  if (!Number.isInteger(first) || first < 1) {
    throw new Error(`expected ${key} failure to be exercised at least once, got ${first}`);
  }
  if (secondCounts[key] !== first) {
    throw new Error(`expected ${key} failure to be cached after first pass, got ${first} then ${secondCounts[key]}`);
  }
}
if (firstCounts.secrets !== undefined && secondCounts.secrets !== firstCounts.secrets) {
  throw new Error(`expected secrets failure to be cached after first pass, got ${firstCounts.secrets} then ${secondCounts.secrets}`);
}
console.log("synthetic bundled channel load failures were isolated and cached");
NODE
)

echo "bundled channel load-failure isolation Docker E2E passed"
EOF
}
