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
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

baseline="${OPENCLAW_UPDATE_CORRUPT_PLUGIN_BASELINE:-openclaw@latest}"
echo "Installing baseline OpenClaw package: $baseline"
if ! npm install -g --prefix /tmp/npm-prefix --omit=optional "$baseline" >/tmp/openclaw-update-corrupt-baseline-install.log 2>&1; then
  cat /tmp/openclaw-update-corrupt-baseline-install.log >&2 || true
  exit 1
fi

package_root="$(openclaw_e2e_package_root /tmp/npm-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
export OPENCLAW_ENTRY="$entry"

npm_pack_dir="$(mktemp -d "/tmp/openclaw-corrupt-plugin-pack.XXXXXX")"
npm_registry_dir="$(mktemp -d "/tmp/openclaw-corrupt-plugin-registry.XXXXXX")"
pack_fixture_plugin "$npm_pack_dir" /tmp/demo-corrupt-plugin.tgz demo-corrupt-plugin 0.0.1 demo.corrupt "Demo Corrupt Plugin"
start_npm_fixture_registry "@openclaw/demo-corrupt-plugin" "0.0.1" /tmp/demo-corrupt-plugin.tgz "$npm_registry_dir"

echo "Installing managed external plugin..."
node "$entry" plugins install "npm:@openclaw/demo-corrupt-plugin@0.0.1" >/tmp/openclaw-corrupt-plugin-install.log 2>&1
node "$entry" plugins inspect demo-corrupt-plugin --runtime --json >/tmp/openclaw-corrupt-plugin-before.json

plugin_dir="$HOME/.openclaw/extensions/demo-corrupt-plugin"
rm -f "$plugin_dir/package.json"

set +e
node "$entry" plugins inspect demo-corrupt-plugin --runtime --json >/tmp/openclaw-corrupt-plugin-broken.json 2>/tmp/openclaw-corrupt-plugin-broken.err
inspect_status=$?
set -e
if [ "$inspect_status" -eq 0 ]; then
  echo "Expected corrupt plugin inspect to fail before update." >&2
  cat /tmp/openclaw-corrupt-plugin-broken.json >&2 || true
  exit 1
fi

echo "Updating OpenClaw with corrupt plugin present..."
set +e
node "$entry" update --channel beta --tag "${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}" --yes --no-restart --json >/tmp/openclaw-update-corrupt-plugin.json 2>/tmp/openclaw-update-corrupt-plugin.err
update_status=$?
set -e
if [ "$update_status" -ne 0 ]; then
  echo "openclaw update failed with corrupt plugin present" >&2
  cat /tmp/openclaw-update-corrupt-plugin.err >&2 || true
  cat /tmp/openclaw-update-corrupt-plugin.json >&2 || true
  exit "$update_status"
fi

node scripts/e2e/lib/plugin-update/probe.mjs assert-corrupt-update /tmp/openclaw-update-corrupt-plugin.json demo-corrupt-plugin
