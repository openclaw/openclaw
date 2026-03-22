#!/usr/bin/env bash
# Fly.io smoke test for Blink Claw pre-release images.
#
# Launches TWO temporary Fly machines using the pre-release image
# (production Starter spec: shared-cpu-2x / 2048MB):
#
#   Machine A  — no WhatsApp config (baseline startup + memory)
#   Machine B  — WhatsApp pre-configured from boot (real OOM test)
#
# Cleans up all test machines on exit.
#
# Usage:   fly-smoke-test.sh [IMAGE]
# Env:     FLY_API_TOKEN  — Fly.io API token (required)
#
# IMAGE defaults to registry.fly.io/blink-claw:pre-release

set -euo pipefail

IMAGE="${1:-registry.fly.io/blink-claw:pre-release}"
TEST_APP="blink-claw-test-runner"
GATEWAY_TOKEN="smoke-test-$(openssl rand -hex 8)"
FLY_API="https://api.machines.dev/v1"
MACHINE_A=""  # baseline (no WhatsApp)
MACHINE_B=""  # WhatsApp pre-configured

# ── Helpers ────────────────────────────────────────────────────────────────────

fly_exec() {
  # fly_exec <machine_id> <shell_command> [timeout_seconds]
  local mid="$1" cmd="$2" timeout="${3:-30}"
  local payload curl_timeout=$(( timeout + 10 ))
  payload=$(python3 -c "import json,sys; print(json.dumps({'command': ['/bin/sh', '-c', sys.argv[1]], 'timeout': int(sys.argv[2])}))" "$cmd" "$timeout")
  curl -sf --max-time "$curl_timeout" -X POST \
    "$FLY_API/apps/$TEST_APP/machines/$mid/exec" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload"
}

fly_exec_stdout() {
  fly_exec "$@" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo ""
}

fly_machine_state() {
  curl -sf "$FLY_API/apps/$TEST_APP/machines/$1" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('state','unknown'))"
}

create_machine() {
  # create_machine <init_entrypoint_json> <init_cmd_json>
  # entrypoint: ["/app/blink-entrypoint.sh"] (default) or custom
  # cmd: the CMD array for the container
  local init_entrypoint="$1" init_cmd="$2"
  local payload
  payload=$(python3 -c "
import json, sys
entrypoint = json.loads(sys.argv[1])
cmd = json.loads(sys.argv[2])
config = {
  'image': sys.argv[3],
  'init': {'entrypoint': entrypoint, 'cmd': cmd},
  'restart': {'policy': 'always'},
  'guest': {'cpu_kind': 'shared', 'cpus': 2, 'memory_mb': 2048},
  'env': {
    'OPENCLAW_GATEWAY_TOKEN': sys.argv[4],
    'OPENCLAW_STATE_DIR': '/data',
    'OPENCLAW_HEADLESS': 'true',
    'NODE_OPTIONS': '--max-old-space-size=1536',
    'NODE_ENV': 'production',
  },
}
print(json.dumps({'region': 'iad', 'config': config}))
" "$init_entrypoint" "$init_cmd" "$IMAGE" "$GATEWAY_TOKEN")
  curl -sf --max-time 30 -X POST \
    "$FLY_API/apps/$TEST_APP/machines" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"
}

wait_machine_started() {
  local mid="$1" label="$2"
  for i in $(seq 1 120); do
    local state; state=$(fly_machine_state "$mid")
    [ "$state" = "started" ] && { echo "    $label started after ${i}s ✓"; return 0; }
    [ "$state" = "failed" ] && { echo "ERROR: $label crashed (state=failed)"; return 1; }
    sleep 1
  done
  echo "ERROR: $label did not start within 120s"
  return 1
}

wait_gateway_healthy() {
  local mid="$1" label="$2" max_wait="${3:-60}"
  local start; start=$(date +%s)
  for i in $(seq 1 "$max_wait"); do
    # Abort if machine crashed (OOM)
    local state; state=$(fly_machine_state "$mid")
    if [ "$state" != "started" ] && [ "$state" != "starting" ]; then
      echo ""
      echo "OOM/CRASH: $label machine entered state=$state!"
      return 1
    fi
    local health; health=$(fly_exec_stdout "$mid" 'curl -sf http://127.0.0.1:18789/healthz 2>/dev/null || echo NOTREADY' 10)
    if echo "$health" | grep -q '"ok"'; then
      echo "$(($(date +%s) - start))s"
      return 0
    fi
    printf "."
    sleep 3
  done
  echo ""
  echo "ERROR: $label gateway not healthy within $((max_wait * 3))s"
  return 1
}

get_memory() {
  local mid="$1"
  fly_exec_stdout "$mid" 'free -m 2>/dev/null | grep "^Mem" | awk '"'"'{printf "%s/%s MB (%.0f%%)", $3, $2, $3/$2*100}'"'"'' 20
}

get_process_rss() {
  local mid="$1"
  fly_exec_stdout "$mid" 'ps aux 2>/dev/null | grep "[o]penclaw-gateway" | awk '"'"'{printf "%.0f MB", $6/1024}'"'"'' 20
}

# ── Cleanup ────────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "==> Cleaning up test machines..."
  for mid in "$MACHINE_A" "$MACHINE_B"; do
    [ -z "$mid" ] && continue
    curl -sf -X POST "$FLY_API/apps/$TEST_APP/machines/$mid/stop" \
      -H "Authorization: Bearer $FLY_API_TOKEN" -H "Content-Type: application/json" \
      --data '{}' --max-time 10 > /dev/null 2>&1 || true
    sleep 2
    curl -sf -X DELETE "$FLY_API/apps/$TEST_APP/machines/$mid?force=true" \
      -H "Authorization: Bearer $FLY_API_TOKEN" --max-time 10 > /dev/null 2>&1 || true
    echo "    Machine $mid destroyed."
  done
}
trap cleanup EXIT

# ── Ensure test app exists ─────────────────────────────────────────────────────
echo "==> Checking test runner app: $TEST_APP"
APP_EXISTS=$(flyctl apps list --org blink-new --json 2>/dev/null \
  | python3 -c "import json,sys; apps=[a['Name'] for a in json.load(sys.stdin)]; print('yes' if '$TEST_APP' in apps else 'no')" 2>/dev/null || echo "no")
if [ "$APP_EXISTS" = "no" ]; then
  echo "    Creating $TEST_APP..."
  flyctl apps create "$TEST_APP" --org blink-new
fi

echo "==> Image: $IMAGE"

# ── Machine A: Baseline (no WhatsApp) ─────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "MACHINE A: Baseline — no WhatsApp configured"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Use default ENTRYPOINT (/app/blink-entrypoint.sh) + default CMD
echo "==> Creating machine A..."
MACHINE_A=$(create_machine \
  '["/app/blink-entrypoint.sh"]' \
  '["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]')
echo "    Machine A: $MACHINE_A"

wait_machine_started "$MACHINE_A" "Machine A"

echo "==> Waiting for baseline gateway health..."
printf "    "
BASELINE_SECS=$(wait_gateway_healthy "$MACHINE_A" "Machine A" 60)
echo "    Baseline gateway healthy in ${BASELINE_SECS} ✓"

BASELINE_MEM=$(get_memory "$MACHINE_A")
BASELINE_RSS=$(get_process_rss "$MACHINE_A")
echo "==> Baseline memory: $BASELINE_MEM | Node.js: $BASELINE_RSS"

# ── Machine B: WhatsApp pre-configured from boot ───────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "MACHINE B: WhatsApp pre-configured (OOM test + QR test)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Custom entrypoint: write WhatsApp config, then call the real entrypoint.
# blink-entrypoint.sh runs as root, preps /data, drops to node, execs CMD.
# Base64-encode the config to avoid shell quoting issues.
WA_CONFIG_B64=$(printf '%s' '{"agents":{"defaults":{"workspace":"/data/workspace"}},"gateway":{"auth":{"mode":"token"},"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}},"browser":{"noSandbox":true},"channels":{"whatsapp":{"accounts":{"default":{"authDir":"/data/workspace/.whatsapp"}}}}}' | base64 | tr -d '\n')

echo "==> Creating machine B (WhatsApp configured from boot)..."
WA_CMD="mkdir -p /data/workspace/.whatsapp /data/agents/main/agent /data/agents/main/sessions /data/scripts /data/npm-global && printf '%s' '${WA_CONFIG_B64}' | base64 -d > /data/openclaw.json && chown -R node:node /data && exec /app/blink-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured"
MACHINE_B=$(create_machine \
  '[ "/bin/sh", "-c" ]' \
  "$(python3 -c "import json; print(json.dumps(['''$WA_CMD''']))")")
echo "    Machine B: $MACHINE_B"

wait_machine_started "$MACHINE_B" "Machine B"

echo "==> Waiting for WhatsApp gateway (Baileys init: 60-120s expected)..."
printf "    "
WA_SECS=$(wait_gateway_healthy "$MACHINE_B" "Machine B" 90)
echo "    WhatsApp gateway healthy in ${WA_SECS} ✓"

WA_MEM=$(get_memory "$MACHINE_B")
WA_RSS=$(get_process_rss "$MACHINE_B")
echo "==> WhatsApp memory: $WA_MEM | Node.js: $WA_RSS"

# Memory warning thresholds
MEM_PCT=$(echo "$WA_MEM" | grep -oP '\d+(?=%)' | tail -1 || echo "0")
if [ "${MEM_PCT:-0}" -gt 85 ] 2>/dev/null; then
  echo "    ⛔ CRITICAL: ${MEM_PCT}% RAM — will OOM when Chromium launches"
elif [ "${MEM_PCT:-0}" -gt 70 ] 2>/dev/null; then
  echo "    ⚠️  WARNING: ${MEM_PCT}% RAM — tight with browser usage"
else
  echo "    ✓ ${MEM_PCT}% RAM — healthy headroom for Chromium"
fi

# ── WhatsApp QR RPC test ───────────────────────────────────────────────────────
echo ""
echo "==> Running WhatsApp QR RPC test..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Encode + write RPC test script into container
B64_SCRIPT=$(base64 < "$SCRIPT_DIR/../../test-whatsapp-rpc.mjs" | tr -d '\n')
fly_exec "$MACHINE_B" "printf '%s' '$B64_SCRIPT' | base64 -d > /app/test-wa-rpc.mjs" 30 > /dev/null

QR_OUTPUT=$(fly_exec_stdout "$MACHINE_B" \
  "cd /app && GATEWAY_TOKEN=$GATEWAY_TOKEN node test-wa-rpc.mjs 2>/dev/null" 60)

echo "    RPC result: $QR_OUTPUT"

# Parse
HAS_ERROR=$(echo "$QR_OUTPUT" | python3 -c "
import json,sys
try:
  d = json.loads(sys.stdin.read() or '{}')
  print('yes' if 'error' in d else 'no')
except: print('yes')" 2>/dev/null || echo "yes")

if [ "$HAS_ERROR" = "yes" ]; then
  QR_ERROR=$(echo "$QR_OUTPUT" | python3 -c "
import json,sys
try: print(json.loads(sys.stdin.read() or '{}').get('error','parse failed'))
except: print(sys.stdin.read())" 2>/dev/null || echo "parse failed")
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  SMOKE TEST FAILED ✗                                    ║"
  echo "╠══════════════════════════════════════════════════════════╣"
  echo "║  WhatsApp QR error: $QR_ERROR"
  echo "╚══════════════════════════════════════════════════════════╝"
  # Print machine B recent logs for debugging
  echo ""
  echo "==> Machine B recent logs:"
  flyctl logs --app "$TEST_APP" --machine "$MACHINE_B" --no-tail 2>&1 | tail -30 || true
  exit 1
fi

QR_LEN=$(echo "$QR_OUTPUT" | python3 -c "
import json,sys
try: print(json.loads(sys.stdin.read() or '{}').get('qrLength',0))
except: print(0)" 2>/dev/null || echo "0")

HAS_QR=$(echo "$QR_OUTPUT" | python3 -c "
import json,sys
try: print(json.loads(sys.stdin.read() or '{}').get('hasQrDataUrl',False))
except: print(False)" 2>/dev/null || echo "False")

# ── Final report ─────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  SMOKE TEST PASSED ✓                                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  WhatsApp QR generated: $HAS_QR"
echo "║  QR size: $QR_LEN bytes"
echo "║  Memory — baseline: $BASELINE_MEM"
echo "║  Memory — WhatsApp: $WA_MEM"
echo "║  Startup — baseline: $BASELINE_SECS"
echo "║  Startup — WhatsApp: $WA_SECS"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Pre-release image is SAFE for production.                  ║"
echo "║  To deploy: push to main OR dispatch mode=production.       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
