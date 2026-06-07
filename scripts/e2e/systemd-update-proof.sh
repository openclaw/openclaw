#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCENARIO="${OPENCLAW_SYSTEMD_PROOF_SCENARIO:-intact-systemd-update}"
ARTIFACT_DIR="${OPENCLAW_SYSTEMD_PROOF_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/systemd-update-proof/$SCENARIO}"
BASELINE_SPEC="${OPENCLAW_SYSTEMD_PROOF_BASELINE_SPEC:-openclaw@2026.6.1-beta.2}"
PROFILE="${OPENCLAW_SYSTEMD_PROOF_PROFILE:-pr91044proof}"
PORT="${OPENCLAW_SYSTEMD_PROOF_PORT:-19879}"
UNIT="openclaw-gateway-${PROFILE}.service"
PREFIX="$ARTIFACT_DIR/npm-prefix"
HOME_DIR="$ARTIFACT_DIR/home"
STATE_DIR="$ARTIFACT_DIR/state"
LOG_DIR="$ARTIFACT_DIR/logs"
SUMMARY_JSON="$ARTIFACT_DIR/summary.json"
CURRENT_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-$ROOT_DIR/openclaw-current.tgz}"

mkdir -p "$ARTIFACT_DIR" "$PREFIX" "$HOME_DIR" "$STATE_DIR" "$LOG_DIR"
export HOME="$HOME_DIR"
export XDG_CONFIG_HOME="$HOME_DIR/.config"
export XDG_CACHE_HOME="$HOME_DIR/.cache"
export OPENCLAW_PROFILE="$PROFILE"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_GATEWAY_PORT="$PORT"
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_PROVIDERS=1
export OPENCLAW_DISABLE_UPDATE_CHECK=1
export OPENCLAW_DISABLE_SANDBOX=1
export npm_config_prefix="$PREFIX"
export PATH="$PREFIX/bin:$PATH"

log() { printf '::notice ::%s\n' "$*"; }
write_summary() {
  local status="$1"
  node - <<'NODE' "$SUMMARY_JSON" "$status" "$SCENARIO" "$BASELINE_SPEC" "$PROFILE" "$PORT" "$UNIT"
const fs = require('fs');
const path = require('path');
const [file, status, scenario, baseline, profile, port, unit] = process.argv.slice(2);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  status,
  scenario,
  baseline,
  profile,
  port,
  unit,
  generatedAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE
}
cleanup() {
  set +e
  systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
  rm -f "$XDG_CONFIG_HOME/systemd/user/$UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_ready() {
  local label="$1"
  local attempts="${2:-90}"
  for i in $(seq 1 "$attempts"); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >"$LOG_DIR/$label-healthz.json" 2>"$LOG_DIR/$label-healthz.err" \
      && curl -fsS "http://127.0.0.1:$PORT/readyz" >"$LOG_DIR/$label-readyz.json" 2>"$LOG_DIR/$label-readyz.err"; then
      return 0
    fi
    sleep 1
  done
  journalctl --user -u "$UNIT" -n 240 --no-pager >"$LOG_DIR/$label-journal.log" 2>&1 || true
  echo "$label gateway did not become ready" >&2
  return 1
}

assert_systemd_user_available() {
  systemctl --user status >"$LOG_DIR/systemctl-user-status-before.out" 2>"$LOG_DIR/systemctl-user-status-before.err"
  systemctl --user show-environment >"$LOG_DIR/systemctl-user-env-before.out" 2>"$LOG_DIR/systemctl-user-env-before.err" || true
}

install_baseline_service() {
  log "installing baseline $BASELINE_SPEC"
  npm install -g "$BASELINE_SPEC" --omit=optional --no-audit --no-fund >"$LOG_DIR/npm-install-baseline.out" 2>"$LOG_DIR/npm-install-baseline.err"
  openclaw --version >"$LOG_DIR/baseline-version.out" 2>"$LOG_DIR/baseline-version.err"
  log "writing isolated local gateway config"
  openclaw config set gateway.mode local >"$LOG_DIR/config-set-gateway-mode.out" 2>"$LOG_DIR/config-set-gateway-mode.err"
  log "installing real systemd user service $UNIT"
  openclaw gateway install --force --json >"$LOG_DIR/baseline-gateway-install.json" 2>"$LOG_DIR/baseline-gateway-install.err"
  systemctl --user daemon-reload >"$LOG_DIR/baseline-daemon-reload.out" 2>"$LOG_DIR/baseline-daemon-reload.err"
  systemctl --user enable --now "$UNIT" >"$LOG_DIR/baseline-enable-now.out" 2>"$LOG_DIR/baseline-enable-now.err"
  wait_ready baseline 90
  systemctl --user show "$UNIT" -p Id -p LoadState -p ActiveState -p SubState -p FragmentPath -p MainPID >"$LOG_DIR/baseline-systemctl-show.out" 2>"$LOG_DIR/baseline-systemctl-show.err"
}

simulate_missing_supervisor_with_live_gateway() {
  log "removing real systemd user unit while leaving gateway process alive"
  unit_path="$XDG_CONFIG_HOME/systemd/user/$UNIT"
  cp "$unit_path" "$LOG_DIR/removed-unit-copy.service"
  rm -f "$unit_path"
  systemctl --user daemon-reload >"$LOG_DIR/missing-daemon-reload.out" 2>"$LOG_DIR/missing-daemon-reload.err"
  systemctl --user show "$UNIT" -p Id -p LoadState -p ActiveState -p SubState -p FragmentPath -p MainPID >"$LOG_DIR/missing-systemctl-show.out" 2>"$LOG_DIR/missing-systemctl-show.err" || true
  curl -fsS "http://127.0.0.1:$PORT/readyz" >"$LOG_DIR/missing-live-readyz.json" 2>"$LOG_DIR/missing-live-readyz.err"
}

run_package_update() {
  log "running real openclaw update package flow from baseline to candidate tarball"
  OPENCLAW_UPDATE_PACKAGE_SPEC="file:$CURRENT_TGZ" \
    openclaw update --tag latest --yes --json >"$LOG_DIR/update-candidate.json" 2>"$LOG_DIR/update-candidate.err"
  openclaw --version >"$LOG_DIR/candidate-version.out" 2>"$LOG_DIR/candidate-version.err"
  wait_ready after-update 120
  systemctl --user show "$UNIT" -p Id -p LoadState -p ActiveState -p SubState -p FragmentPath -p MainPID >"$LOG_DIR/after-update-systemctl-show.out" 2>"$LOG_DIR/after-update-systemctl-show.err"
  journalctl --user -u "$UNIT" -n 240 --no-pager >"$LOG_DIR/after-update-journal.log" 2>&1 || true
}

assert_after_update() {
  grep -q '^LoadState=loaded$' "$LOG_DIR/after-update-systemctl-show.out"
  grep -q '^ActiveState=active$' "$LOG_DIR/after-update-systemctl-show.out"
  node - <<'NODE' "$LOG_DIR/update-candidate.json"
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const lastJsonLine = raw.trim().split(/\n/).reverse().find((line) => line.trim().startsWith('{'));
const parsed = JSON.parse(lastJsonLine || raw);
if (!['ok', 'warning'].includes(String(parsed.status))) {
  throw new Error(`unexpected update status: ${parsed.status}`);
}
NODE
}

log "real systemd proof environment: GitHub-hosted Linux runner, real systemctl --user, scenario=$SCENARIO, profile=$PROFILE, unit=$UNIT"
assert_systemd_user_available
install_baseline_service
case "$SCENARIO" in
  intact-systemd-update)
    ;;
  missing-supervisor-systemd-update)
    simulate_missing_supervisor_with_live_gateway
    ;;
  *)
    echo "unknown scenario: $SCENARIO" >&2
    exit 2
    ;;
esac
run_package_update
assert_after_update
write_summary passed
log "systemd update proof passed scenario=$SCENARIO"
