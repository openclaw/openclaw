#!/usr/bin/env bash
# Shared helpers for Talk idle-timeout live proof scripts.
set -euo pipefail

REPO="${REPO:-$HOME/git/openclaw}"
TEST_CONFIG="${TEST_CONFIG:-$HOME/.openclaw/openclaw.talk-idle-test.json}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
IDLE_WAIT_SEC="${IDLE_WAIT_SEC:-60}"
LOG_LOOKBACK="${LOG_LOOKBACK:-10m}"
LOG_ROOT="${LOG_ROOT:-/tmp/talk-idle-proof}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$LOG_ROOT/run-$RUN_ID}"

openclaw_cli() {
  OPENCLAW_CONFIG_PATH="$TEST_CONFIG" node "$REPO/dist/index.js" "$@"
}

mkdir -p "$EVIDENCE_DIR"

log() {
  printf '[talk-idle-proof] %s\n' "$*"
}

die() {
  printf '[talk-idle-proof] ERROR: %s\n' "$*" >&2
  exit 1
}

prompt() {
  local msg="$1"
  printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  printf '%s\n' "$msg"
  printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  read -r -p 'Press Enter when ready (or Ctrl+C to abort)... '
}

prompt_yn() {
  local msg="$1"
  local default="${2:-y}"
  local answer=""
  printf '%s' "$msg"
  if [[ "$default" == "y" ]]; then
    read -r -p ' [Y/n]: ' answer
    answer="${answer:-y}"
  else
    read -r -p ' [y/N]: ' answer
    answer="${answer:-n}"
  fi
  [[ "$answer" =~ ^[Yy] ]]
}

gateway_pid() {
  lsof -ti "tcp:$GATEWAY_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

wait_for_gateway() {
  local tries="${1:-30}"
  local i=0
  while (( i < tries )); do
    if openclaw_cli gateway status 2>/dev/null | rg -q 'Connectivity probe: ok'; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

ensure_gateway() {
  if wait_for_gateway 3; then
    log "Gateway probe ok on port $GATEWAY_PORT"
    return 0
  fi

  log "Gateway not reachable; starting in background..."
  launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
  pkill -f "dist/index.js gateway" 2>/dev/null || true
  sleep 2

  export OPENCLAW_CONFIG_PATH="$TEST_CONFIG"
  nohup /bin/sh "$HOME/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh" \
    "$HOME/.openclaw/service-env/ai.openclaw.gateway.env" \
    /opt/homebrew/opt/node/bin/node \
    "$REPO/dist/index.js" gateway --port "$GATEWAY_PORT" \
    >>"$EVIDENCE_DIR/gateway.log" 2>&1 &

  if ! wait_for_gateway 45; then
    die "Gateway failed to start. See $EVIDENCE_DIR/gateway.log"
  fi
  log "Gateway started (PID $(gateway_pid))"
}

restart_gateway() {
  log "Restarting gateway to pick up config changes..."
  pkill -f "dist/index.js gateway" 2>/dev/null || true
  sleep 2
  ensure_gateway
}

set_realtime_transport() {
  local transport="$1"
  python3 - "$transport" "$TEST_CONFIG" <<'PY'
import json, sys
transport, path = sys.argv[1], sys.argv[2]
data = json.load(open(path))
rt = data.setdefault("talk", {}).setdefault("realtime", {})
rt["mode"] = "realtime"
rt["brain"] = "agent-consult"
rt["transport"] = transport
data["talk"]["idleTimeoutS"] = 30
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"config: transport={transport}, idleTimeoutS=30")
PY
}

capture_talk_config() {
  local out="$1"
  openclaw_cli gateway call talk.config --params '{}' >"$out" 2>&1 || true
}

capture_runtime_logs() {
  local scenario="$1"
  local out_dir="$EVIDENCE_DIR/$scenario"
  mkdir -p "$out_dir"
  local raw="$out_dir/talk.runtime.log"
  local filtered="$out_dir/talk.runtime.filtered.txt"

  log "Capturing talk.runtime logs (last ${LOG_LOOKBACK})..."
  if [[ -x "$REPO/scripts/clawlog.sh" ]]; then
    if "$REPO/scripts/clawlog.sh" -c talk.runtime --all -l "$LOG_LOOKBACK" -n 500 -o "$raw" 2>"$out_dir/clawlog.err"; then
      :
    else
      log "clawlog failed; trying log show without sudo..."
      log show --style compact \
        --predicate 'subsystem == "ai.openclaw" AND category == "talk.runtime"' \
        --last "$LOG_LOOKBACK" 2>/dev/null >"$raw" || true
    fi
    # Dedicated capture for expiry line (clawlog -s idleTimeout misses "idle timeout expired").
    "$REPO/scripts/clawlog.sh" -c talk.runtime --all -l "$LOG_LOOKBACK" -s "idle timeout" -n 50 \
      -o "$out_dir/talk.runtime.idle-timeout.log" 2>>"$out_dir/clawlog.err" || true
  else
    log show --style compact \
      --predicate 'subsystem == "ai.openclaw" AND category == "talk.runtime"' \
      --last "$LOG_LOOKBACK" 2>/dev/null >"$raw" || true
  fi

  {
    rg -n "idleTimeoutS=|idle timeout expired|talk enabled=|talk send start|talk chat.send|realtimeTransport=|macOSRealtimeOptIn=" \
      "$raw" 2>/dev/null || true
    if [[ -s "$out_dir/talk.runtime.idle-timeout.log" ]]; then
      rg -n "idle timeout expired" "$out_dir/talk.runtime.idle-timeout.log" 2>/dev/null || true
    fi
  } | sort -u >"$filtered" 2>/dev/null || true

  printf '%s\n' "$raw"
}

record_scenario_meta() {
  local scenario="$1"
  local title="$2"
  local setup="$3"
  local steps="$4"
  local out_dir="$EVIDENCE_DIR/$scenario"
  mkdir -p "$out_dir"

  openclaw_cli --version >"$out_dir/openclaw-version.txt" 2>&1 || true
  capture_talk_config "$out_dir/talk.config.json"

  python3 - "$scenario" "$title" "$setup" "$steps" "$out_dir/meta.json" <<'PY'
import json, sys, os
from datetime import datetime, timezone
scenario, title, setup, steps, path = sys.argv[1:6]
payload = {
    "id": scenario,
    "title": title,
    "setup": setup,
    "steps": steps,
    "capturedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "idleWaitSec": int(os.environ.get("IDLE_WAIT_SEC", "60")),
    "testConfig": os.environ.get("TEST_CONFIG", ""),
    "gatewayPort": int(os.environ.get("GATEWAY_PORT", "18789")),
}
json.dump(payload, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
}

finish_scenario() {
  local scenario="$1"
  local ui_outcome="$2"
  local pass="${3:-unknown}"
  local out_dir="$EVIDENCE_DIR/$scenario"
  mkdir -p "$out_dir"

  python3 - "$ui_outcome" "$pass" "$out_dir/result.json" <<'PY'
import json, sys
ui, pass_flag, path = sys.argv[1], sys.argv[2], sys.argv[3]
json.dump({"uiOutcome": ui, "pass": pass_flag}, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY

  log "Scenario $scenario finished (pass=$pass). Artifacts: $out_dir"
}

write_evidence_report() {
  local report="$EVIDENCE_DIR/PR-EVIDENCE.md"
  local version commit
  version="$(openclaw_cli --version 2>/dev/null | head -1 || echo unknown)"
  commit="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  cat >"$report" <<EOF
# Evidence — Talk idle timeout (live)

Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)  
Run directory: \`$EVIDENCE_DIR\`

## Environment

| Item | Value |
|------|--------|
| Branch HEAD | \`$commit\` |
| CLI | $version |
| Test config | \`$TEST_CONFIG\` |
| Gateway | \`127.0.0.1:$GATEWAY_PORT\` |
| \`talk.idleTimeoutS\` | 30 |
| Idle wait (script) | ${IDLE_WAIT_SEC}s |

EOF

  for scenario in scenario1 scenario2 scenario3; do
    local dir="$EVIDENCE_DIR/$scenario"
    [[ -d "$dir" ]] || continue

    local block
    block="$(python3 - "$dir" <<'PY'
import json, pathlib, sys
d = pathlib.Path(sys.argv[1])
meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").is_file() else {}
result = json.loads((d / "result.json").read_text()) if (d / "result.json").is_file() else {}
print(meta.get("title", d.name))
print(meta.get("setup", "n/a"))
print(meta.get("steps", "n/a"))
print(result.get("uiOutcome", "not recorded"))
print(result.get("pass", "unknown"))
PY
)"
    local title setup steps ui_outcome pass_flag
    title="$(printf '%s' "$block" | sed -n '1p')"
    setup="$(printf '%s' "$block" | sed -n '2p')"
    steps="$(printf '%s' "$block" | sed -n '3p')"
    ui_outcome="$(printf '%s' "$block" | sed -n '4p')"
    pass_flag="$(printf '%s' "$block" | sed -n '5p')"

    cat >>"$report" <<EOF
## $title

**Setup:** $setup

**Steps:** $steps

**UI outcome:** $ui_outcome

**Result:** $pass_flag

**Filtered logs:**

\`\`\`
$(cat "$dir/talk.runtime.filtered.txt" 2>/dev/null || echo "(no matching log lines — check talk.runtime.log or run clawlog with sudo)")
\`\`\`

**talk.config excerpt (redact secrets before posting):**

\`\`\`json
$(python3 - <<'PY' "$dir/talk.config.json" 2>/dev/null || echo "{}"
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    talk = d.get("config", d).get("talk", d.get("talk", {}))
    rt = talk.get("realtime", {})
    print(json.dumps({
        "idleTimeoutS": talk.get("idleTimeoutS"),
        "agentId": talk.get("agentId"),
        "realtime": {
            "mode": rt.get("mode"),
            "transport": rt.get("transport"),
            "brain": rt.get("brain"),
        },
    }, indent=2))
except Exception:
    print("{}")
PY
)
\`\`\`

EOF
  done

  cat >>"$report" <<'EOF'
## Before posting to GitHub

- Redact API keys, tokens, session keys, and private transcript text.
- Attach screenshots if you captured them (optional).
- Confirm each scenario shows `talk idle timeout expired after ~30`.

EOF

  log "Evidence report written: $report"
  echo "$report"
}
