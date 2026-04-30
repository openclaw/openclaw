#!/usr/bin/env bash
# Installs the packed OpenClaw tarball over a dirty old-user state fixture, runs
# the package update/doctor paths, then proves the Gateway still boots.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-upgrade-survivor-e2e" OPENCLAW_UPGRADE_SURVIVOR_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-900s}"
BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-}"

docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 upgrade-survivor upgrade-survivor)"

docker_e2e_build_or_reuse "$IMAGE_NAME" upgrade-survivor "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running upgrade survivor Docker E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_TEST_STATE_SCRIPT_B64="$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="${OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS:-90}" \
  -e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="${OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS:-30}" \
  -e OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="$BASELINE_SPEC" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  timeout "$DOCKER_RUN_TIMEOUT" bash -lc 'set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PATH="/tmp/npm-prefix/bin:$PATH"
export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_DISABLE_BONJOUR=1
export GATEWAY_AUTH_TOKEN_REF="upgrade-survivor-token"
export OPENAI_API_KEY="sk-openclaw-upgrade-survivor"
export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"
export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"

gateway_pid=""
cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
}
trap cleanup EXIT

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed

if [ -n "${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-}" ]; then
  echo "Installing published upgrade survivor baseline: ${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC}"
  if ! npm install -g --prefix /tmp/npm-prefix "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC" --no-fund --no-audit >/tmp/openclaw-upgrade-survivor-install.log 2>&1; then
    echo "npm install failed for upgrade survivor baseline" >&2
    cat /tmp/openclaw-upgrade-survivor-install.log >&2 || true
    exit 1
  fi
else
  openclaw_e2e_install_package /tmp/openclaw-upgrade-survivor-install.log "upgrade survivor package" /tmp/npm-prefix
fi
command -v openclaw >/dev/null
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/npm-prefix/lib/node_modules/openclaw/package.json\", \"utf8\")).version")"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

echo "Checking dirty-state config before update..."
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state

echo "Running package update against the mounted tarball..."
set +e
openclaw update --tag "${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}" --yes --json --no-restart >/tmp/openclaw-upgrade-survivor-update.json 2>/tmp/openclaw-upgrade-survivor-update.err
update_status=$?
set -e
if [ "$update_status" -ne 0 ]; then
  echo "openclaw update failed" >&2
  cat /tmp/openclaw-upgrade-survivor-update.err >&2 || true
  cat /tmp/openclaw-upgrade-survivor-update.json >&2 || true
  exit "$update_status"
fi

echo "Running non-interactive doctor repair..."
if ! openclaw doctor --fix --non-interactive >/tmp/openclaw-upgrade-survivor-doctor.log 2>&1; then
  echo "openclaw doctor failed" >&2
  cat /tmp/openclaw-upgrade-survivor-doctor.log >&2 || true
  exit 1
fi

echo "Verifying config and state survived update/doctor..."
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state

PORT=18789
START_BUDGET="${OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS:-90}"
STATUS_BUDGET="${OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS:-30}"

echo "Starting gateway from upgraded state..."
start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >/tmp/openclaw-upgrade-survivor-gateway.log 2>&1 &
gateway_pid="$!"
openclaw_e2e_wait_gateway_ready "$gateway_pid" /tmp/openclaw-upgrade-survivor-gateway.log 360
ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
if [ "$start_seconds" -gt "$START_BUDGET" ]; then
  echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${START_BUDGET}s" >&2
  cat /tmp/openclaw-upgrade-survivor-gateway.log >&2 || true
  exit 1
fi

echo "Checking gateway RPC status..."
status_start="$(node -e "process.stdout.write(String(Date.now()))")"
if ! openclaw gateway status --url "ws://127.0.0.1:$PORT" --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json >/tmp/openclaw-upgrade-survivor-status.json 2>/tmp/openclaw-upgrade-survivor-status.err; then
  echo "gateway status failed" >&2
  cat /tmp/openclaw-upgrade-survivor-status.err >&2 || true
  cat /tmp/openclaw-upgrade-survivor-gateway.log >&2 || true
  exit 1
fi
status_end="$(node -e "process.stdout.write(String(Date.now()))")"
status_seconds=$(((status_end - status_start + 999) / 1000))
if [ "$status_seconds" -gt "$STATUS_BUDGET" ]; then
  echo "gateway status exceeded survivor budget: ${status_seconds}s > ${STATUS_BUDGET}s" >&2
  cat /tmp/openclaw-upgrade-survivor-status.json >&2 || true
  exit 1
fi
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-status-json /tmp/openclaw-upgrade-survivor-status.json

echo "Upgrade survivor Docker E2E passed in startup=${start_seconds}s status=${status_seconds}s."
'
