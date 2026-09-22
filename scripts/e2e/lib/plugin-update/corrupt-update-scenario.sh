#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/plugins/fixtures.sh

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PATH="/tmp/npm-prefix/bin:$PATH"
export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

candidate_package="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
update_timeout_seconds="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPDATE_CORRUPT_PLUGIN_TIMEOUT_SECONDS 900)"
default_update_step_timeout_seconds="$update_timeout_seconds"
if [ "$update_timeout_seconds" -gt 60 ]; then
  default_update_step_timeout_seconds=$((10#$update_timeout_seconds - 30))
fi
update_step_timeout_seconds="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPDATE_CORRUPT_PLUGIN_STEP_TIMEOUT_SECONDS "$default_update_step_timeout_seconds")"
echo "Installing prepared candidate before same-schema corrupt-plugin update..."
if ! openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$candidate_package" >/tmp/openclaw-update-corrupt-baseline-install.log 2>&1; then
  openclaw_e2e_print_log /tmp/openclaw-update-corrupt-baseline-install.log >&2
  exit 1
fi

package_root="$(openclaw_e2e_package_root /tmp/npm-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
export OPENCLAW_ENTRY="$entry"

npm_pack_dir="$(mktemp -d "/tmp/openclaw-corrupt-plugin-pack.XXXXXX")"
npm_registry_dir="$(mktemp -d "/tmp/openclaw-corrupt-plugin-registry.XXXXXX")"
trap 'rm -rf "$npm_pack_dir" "$npm_registry_dir"' EXIT
future_package="$npm_pack_dir/openclaw-future.tgz"
node scripts/e2e/lib/update-first-hop-package-fixtures.mjs   future-tarball "$candidate_package" "$future_package"   >/tmp/openclaw-corrupt-plugin-update-method.json
cat /tmp/openclaw-corrupt-plugin-update-method.json
future_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).targetVersion' /tmp/openclaw-corrupt-plugin-update-method.json)"
pack_fixture_plugin "$npm_pack_dir" /tmp/demo-corrupt-plugin.tgz demo-corrupt-plugin 0.0.1 demo.corrupt "Demo Corrupt Plugin"
(
  # Keep the fixture registry scoped to installation so the first update cannot recover the plugin.
  # The parent retains the pack directory needed for post-core result evidence.
  trap - EXIT
  start_npm_fixture_registry "@openclaw/demo-corrupt-plugin" "0.0.1" /tmp/demo-corrupt-plugin.tgz "$npm_registry_dir"

  echo "Installing managed external plugin..."
  if ! openclaw_e2e_fixture_plugin_command node "$entry" -- plugins install "npm:@openclaw/demo-corrupt-plugin@0.0.1" --force >/tmp/openclaw-corrupt-plugin-install.log 2>&1; then
    openclaw_e2e_print_log /tmp/openclaw-corrupt-plugin-install.log >&2
    exit 1
  fi
  node "$entry" config set plugins.allow '["demo-corrupt-plugin"]' >/dev/null
  node "$entry" config set agents.defaults.model anthropic/claude-sonnet-4-6 >/dev/null
  # Keep Doctor's route repair from re-enabling the unrelated Codex runtime.
  node "$entry" config set plugins.entries.codex.enabled false >/dev/null
  node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-policy-preserved "$OPENCLAW_CONFIG_PATH" demo-corrupt-plugin
  node "$entry" plugins inspect demo-corrupt-plugin --runtime --json >/tmp/openclaw-corrupt-plugin-before.json
)

plugin_dir="$(
  node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const installPath = payload.install?.installPath ?? payload.plugin?.rootDir;
    if (!installPath) {
      throw new Error("missing plugin install path in inspect output");
    }
    process.stdout.write(installPath);
  ' /tmp/openclaw-corrupt-plugin-before.json
)"
rm -f "$plugin_dir/package.json"
if [ -f "$plugin_dir/package.json" ]; then
  echo "Expected corrupt plugin package.json to be removed before update." >&2
  exit 1
fi

capture_corrupt_state() {
  node --input-type=module - "$OPENCLAW_CONFIG_PATH" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { readPluginInstallRecords } from "./scripts/e2e/lib/plugin-index-sqlite.mjs";
const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const record = readPluginInstallRecords()["demo-corrupt-plugin"];
if (!record?.installPath) {
  throw new Error("missing installed path for the corrupt-plugin fixture");
}
const pluginDir = record.installPath;
const model = config.agents?.defaults?.model;
const packageJsonPath = path.join(pluginDir, "package.json");
process.stdout.write(JSON.stringify({
  choices: {
    enabled: config.plugins?.entries?.["demo-corrupt-plugin"]?.enabled !== false,
    codexEnabled: config.plugins?.entries?.codex?.enabled,
    model: typeof model === "string" ? model : model?.primary,
  },
  record,
  packageJson: fs.existsSync(packageJsonPath)
    ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
    : null,
  entry: fs.readFileSync(path.join(pluginDir, "index.js"), "utf8"),
  manifest: fs.readFileSync(path.join(pluginDir, "openclaw.plugin.json"), "utf8"),
}));
NODE
}

run_corrupt_update() {
  local output_prefix="$1"
  openclaw_e2e_maybe_timeout "${update_timeout_seconds}s" \
    node "$entry" update \
    --channel beta \
    --tag "$future_package" \
    --yes \
    --no-restart \
    --timeout "$update_step_timeout_seconds" \
    --json \
    >"$output_prefix.json" 2>"$output_prefix.err"
}

echo "Updating core while the corrupt plugin target is unavailable..."
state_before_update="$(capture_corrupt_state)"
if run_corrupt_update /tmp/openclaw-corrupt-plugin-unavailable; then
  update_status=0
else
  update_status=$?
fi
if [ "$update_status" -ne 0 ]; then
  echo "Unavailable plugin target blocked the core update." >&2
  openclaw_e2e_print_log /tmp/openclaw-corrupt-plugin-unavailable.err >&2
  openclaw_e2e_print_log /tmp/openclaw-corrupt-plugin-unavailable.json >&2
  exit "$update_status"
fi
node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-unavailable /tmp/openclaw-corrupt-plugin-unavailable.json demo-corrupt-plugin
if [ "$(capture_corrupt_state)" != "$state_before_update" ]; then
  echo "Unavailable plugin update changed its install record, retained payload, or user choices." >&2
  exit 1
fi
node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-policy-preserved "$OPENCLAW_CONFIG_PATH" demo-corrupt-plugin
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-package-version "$package_root" "$future_version" unavailable-plugin-tolerance

# Reinstall the same explicit core artifact after the plugin registry becomes available.
# The plugin must recover even though the installed core version is already current.
mkdir "$npm_registry_dir/recovery"
export OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org/
start_npm_fixture_registry "@openclaw/demo-corrupt-plugin" "0.0.1" /tmp/demo-corrupt-plugin.tgz "$npm_registry_dir/recovery"
echo "Updating OpenClaw with a recoverable corrupt plugin present..."
if run_corrupt_update /tmp/openclaw-update-corrupt-plugin; then
  update_status=0
else
  update_status=$?
fi
if [ "$update_status" -ne 0 ]; then
  echo "openclaw update failed or timed out after ${update_timeout_seconds}s with corrupt plugin present" >&2
  openclaw_e2e_print_log /tmp/openclaw-update-corrupt-plugin.err >&2
  openclaw_e2e_print_log /tmp/openclaw-update-corrupt-plugin.json >&2
  exit "$update_status"
fi
node scripts/e2e/lib/release-scenarios/assertions.mjs   assert-package-version "$package_root" "$future_version" same-version-plugin-repair

node --input-type=module - "$state_before_update" "$(capture_corrupt_state)" <<'NODE'
import assert from "node:assert/strict";
const [before, after] = process.argv.slice(2).map((value) => JSON.parse(value));
assert.deepEqual(after.choices, before.choices, "plugin repair changed user choices");
assert.equal(after.record?.source, before.record.source, "plugin repair changed the recorded source");
assert.equal(after.record?.spec, before.record.spec, "plugin repair changed the recorded selector");
assert.equal(
  after.packageJson?.name,
  "@openclaw/demo-corrupt-plugin",
  "plugin package.json was not restored",
);
assert.equal(after.packageJson?.version, "0.0.1", "plugin repair installed an unexpected version");
assert.equal(after.entry, before.entry, "plugin repair changed the expected entry payload");
assert.equal(after.manifest, before.manifest, "plugin repair changed the expected manifest payload");
NODE

if ! node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-update /tmp/openclaw-update-corrupt-plugin.json demo-corrupt-plugin; then
  echo "corrupt update JSON payload:" >&2
  openclaw_e2e_print_log /tmp/openclaw-update-corrupt-plugin.json >&2
  echo "corrupt update stderr:" >&2
  openclaw_e2e_print_log /tmp/openclaw-update-corrupt-plugin.err >&2
  exit 1
fi
node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-policy-preserved "$OPENCLAW_CONFIG_PATH" demo-corrupt-plugin
