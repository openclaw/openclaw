#!/usr/bin/env bash
# Fly.io smoke test for Blink Claw pre-release images.
#
# Launches a temporary Fly machine using the pre-release image
# (production Starter spec: shared-cpu-2x / 2048MB), enables WhatsApp,
# verifies the QR code is generated, and checks for OOM/crash.
# Cleans up on exit.
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
MACHINE_ID=""

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

fly_machine_state() {
  curl -sf "$FLY_API/apps/$TEST_APP/machines/$1" \
    -H "Authorization: Bearer $FLY_API_TOKEN" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('state','unknown'))"
}

# ── Cleanup ────────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "==> Cleaning up test machine..."
  if [ -n "$MACHINE_ID" ]; then
    curl -sf -X POST \
      "$FLY_API/apps/$TEST_APP/machines/$MACHINE_ID/stop" \
      -H "Authorization: Bearer $FLY_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data '{}' > /dev/null 2>&1 || true
    sleep 3
    curl -sf -X DELETE \
      "$FLY_API/apps/$TEST_APP/machines/$MACHINE_ID?force=true" \
      -H "Authorization: Bearer $FLY_API_TOKEN" > /dev/null 2>&1 || true
    echo "    Machine $MACHINE_ID destroyed."
  fi
}
trap cleanup EXIT

# ── Ensure test app exists (idempotent) ───────────────────────────────────────
echo "==> Checking test runner app: $TEST_APP"
APP_EXISTS=$(flyctl apps list --org blink-new --json 2>/dev/null \
  | python3 -c "import json,sys; apps=[a['Name'] for a in json.load(sys.stdin)]; print('yes' if '$TEST_APP' in apps else 'no')" 2>/dev/null || echo "no")

if [ "$APP_EXISTS" = "no" ]; then
  echo "    Creating app $TEST_APP (one-time setup)..."
  flyctl apps create "$TEST_APP" --org blink-new
fi

# ── Launch test machine ───────────────────────────────────────────────────────
echo ""
echo "==> Launching test machine (shared-cpu-2x / 2048MB — matches production Starter)..."
echo "    Image: $IMAGE"

CREATE_PAYLOAD=$(python3 -c "
import json, sys
config = {
  'image': sys.argv[1],
  'init': {'cmd': ['node', '/app/openclaw.mjs', 'gateway', '--allow-unconfigured']},
  'restart': {'policy': 'no'},
  'guest': {'cpu_kind': 'shared', 'cpus': 2, 'memory_mb': 2048},
  'env': {
    'OPENCLAW_GATEWAY_TOKEN': sys.argv[2],
    'OPENCLAW_STATE_DIR': '/data',
    'OPENCLAW_HEADLESS': 'true',
    'NODE_OPTIONS': '--max-old-space-size=1536',
    'NODE_ENV': 'production',
  },
}
print(json.dumps({'region': 'iad', 'config': config}))
" "$IMAGE" "$GATEWAY_TOKEN")

CREATE_RESP=$(curl -sf -X POST \
  "$FLY_API/apps/$TEST_APP/machines" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$CREATE_PAYLOAD")

MACHINE_ID=$(echo "$CREATE_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
if [ -z "$MACHINE_ID" ] || [ "$MACHINE_ID" = "null" ]; then
  echo "ERROR: Failed to create test machine"
  echo "Response: $CREATE_RESP"
  exit 1
fi
echo "    Machine ID: $MACHINE_ID"

# ── Wait for machine to reach 'started' state ─────────────────────────────────
echo ""
echo "==> Waiting for machine to start..."
for i in $(seq 1 60); do
  STATE=$(fly_machine_state "$MACHINE_ID")
  if [ "$STATE" = "started" ]; then
    echo "    Machine started after ${i}s"
    break
  fi
  if [ "$STATE" = "failed" ] || [ "$STATE" = "destroyed" ]; then
    echo "ERROR: Machine entered state: $STATE after ${i}s"
    flyctl logs --app "$TEST_APP" --machine-id "$MACHINE_ID" 2>&1 | tail -20
    exit 1
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Machine did not start within 60s (state=$STATE)"
    exit 1
  fi
done

# ── Wait for OpenClaw gateway health (baseline, no WhatsApp) ──────────────────
echo ""
echo "==> Waiting for baseline gateway health (no WhatsApp — should be <15s)..."
BASELINE_START=$(date +%s)
GATEWAY_UP=false
for i in $(seq 1 30); do
  HEALTH=$(fly_exec "$MACHINE_ID" \
    'curl -sf http://127.0.0.1:18789/healthz 2>/dev/null || echo NOTREADY' 15 \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stdout','NOTREADY'))" 2>/dev/null || echo "NOTREADY")
  if echo "$HEALTH" | grep -q '"ok"'; then
    BASELINE_SECS=$(( $(date +%s) - BASELINE_START ))
    echo "    Baseline gateway healthy in ${BASELINE_SECS}s ✓"
    GATEWAY_UP=true
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Baseline gateway not healthy within 60s"
    flyctl logs --app "$TEST_APP" --machine-id "$MACHINE_ID" 2>&1 | tail -30
    exit 1
  fi
done

# ── Baseline memory ────────────────────────────────────────────────────────────
echo ""
echo "==> Baseline memory (no WhatsApp):"
BASELINE_MEM=$(fly_exec "$MACHINE_ID" \
  'free -m 2>/dev/null | grep "^Mem" | awk '"'"'{printf "%s/%s MB (%.0f%%)", $3, $2, $3/$2*100}'"'"'' 30 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','unavailable').strip())" 2>/dev/null || echo "unavailable")
echo "    RAM: $BASELINE_MEM"

PROC_MEM=$(fly_exec "$MACHINE_ID" \
  'ps aux 2>/dev/null | grep "[o]penclaw-gateway" | awk '"'"'{printf "%.0f MB RSS", $6/1024}'"'"'' 30 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','unavailable').strip())" 2>/dev/null || echo "unavailable")
echo "    Node.js process: $PROC_MEM"

# ── Enable WhatsApp in openclaw.json + restart process ────────────────────────
echo ""
echo "==> Writing WhatsApp config and restarting OpenClaw process..."

WA_CONFIG='{"agents":{"defaults":{"workspace":"/data/workspace"}},"gateway":{"auth":{"mode":"token"},"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}},"browser":{"noSandbox":true},"channels":{"whatsapp":{"accounts":{"default":{"authDir":"/data/workspace/.whatsapp"}}}}}'

fly_exec "$MACHINE_ID" \
  "mkdir -p /data/workspace/.whatsapp && printf '%s' '$WA_CONFIG' > /data/openclaw.json" 30 > /dev/null

fly_exec "$MACHINE_ID" \
  'pkill -f "openclaw.mjs" 2>/dev/null; pkill -f "node /app/openclaw" 2>/dev/null; true' 15 \
  > /dev/null 2>&1 || true

# ── Wait for gateway with WhatsApp to come up ─────────────────────────────────
echo ""
echo "==> Waiting for gateway with WhatsApp (Baileys init: expect 60-120s)..."
WA_START=$(date +%s)
WA_UP=false
for i in $(seq 1 90); do
  # Also check machine hasn't crashed (OOM)
  STATE=$(fly_machine_state "$MACHINE_ID")
  if [ "$STATE" != "started" ] && [ "$STATE" != "starting" ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  OOM / CRASH DETECTED ✗                                 ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    echo "║  Machine state: $STATE after WhatsApp init"
    echo "║  This is likely an OOM kill from Baileys memory spike."
    echo "║  Consider increasing machine size or reducing memory use."
    echo "╚══════════════════════════════════════════════════════════╝"
    flyctl logs --app "$TEST_APP" --machine-id "$MACHINE_ID" 2>&1 | tail -40
    exit 1
  fi

  HEALTH=$(fly_exec "$MACHINE_ID" \
    'curl -sf http://127.0.0.1:18789/healthz 2>/dev/null || echo NOTREADY' 10 \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','NOTREADY'))" 2>/dev/null || echo "NOTREADY")

  if echo "$HEALTH" | grep -q '"ok"'; then
    WA_SECS=$(( $(date +%s) - WA_START ))
    echo "    Gateway (WhatsApp) healthy in ${WA_SECS}s ✓"
    WA_UP=true
    break
  fi
  printf "."
  sleep 3
  if [ "$i" -eq 90 ]; then
    echo ""
    echo "ERROR: Gateway with WhatsApp not healthy within 270s"
    flyctl logs --app "$TEST_APP" --machine-id "$MACHINE_ID" 2>&1 | tail -40
    exit 1
  fi
done
echo ""

# ── Post-WhatsApp memory check ─────────────────────────────────────────────────
echo ""
echo "==> Memory WITH WhatsApp running:"
WA_MEM=$(fly_exec "$MACHINE_ID" \
  'free -m 2>/dev/null | grep "^Mem" | awk '"'"'{printf "%s/%s MB (%.0f%%)", $3, $2, $3/$2*100}'"'"'' 30 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','unavailable').strip())" 2>/dev/null || echo "unavailable")
echo "    RAM: $WA_MEM"

WA_PROC_MEM=$(fly_exec "$MACHINE_ID" \
  'ps aux 2>/dev/null | grep "[o]penclaw-gateway" | awk '"'"'{printf "%.0f MB RSS", $6/1024}'"'"'' 30 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','unavailable').strip())" 2>/dev/null || echo "unavailable")
echo "    Node.js process: $WA_PROC_MEM"

# Warn if memory is critically high
MEM_PCT=$(fly_exec "$MACHINE_ID" \
  'free 2>/dev/null | grep "^Mem" | awk '"'"'{printf "%.0f", $3/$2*100}'"'"'' 30 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','0').strip())" 2>/dev/null || echo "0")

MEM_PCT="${MEM_PCT//[^0-9]/}"
MEM_PCT="${MEM_PCT:-0}"

if [ "$MEM_PCT" -gt 90 ] 2>/dev/null; then
  echo "    ⛔ CRITICAL: ${MEM_PCT}% RAM used — machine will OOM with browser active"
elif [ "$MEM_PCT" -gt 80 ] 2>/dev/null; then
  echo "    ⚠️  WARNING: ${MEM_PCT}% RAM used — tight, may OOM if Chromium launches"
elif [ "$MEM_PCT" -gt 65 ] 2>/dev/null; then
  echo "    ⚡ NOTICE: ${MEM_PCT}% RAM used — monitor browser memory usage"
else
  echo "    ✓ ${MEM_PCT}% RAM used — healthy headroom"
fi

# ── WhatsApp QR test ──────────────────────────────────────────────────────────
echo ""
echo "==> Running WhatsApp QR RPC test..."

# Encode the RPC test script as base64 and write it to the machine safely
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
B64_SCRIPT=$(base64 < "$SCRIPT_DIR/../../test-whatsapp-rpc.mjs" | tr -d '\n')
fly_exec "$MACHINE_ID" \
  "printf '%s' '$B64_SCRIPT' | base64 -d > /app/test-wa-rpc.mjs" 30 > /dev/null

QR_OUTPUT=$(fly_exec "$MACHINE_ID" \
  "cd /app && GATEWAY_TOKEN=$GATEWAY_TOKEN node test-wa-rpc.mjs 2>/dev/null" 60 \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null || echo "")

echo "    RPC result: $QR_OUTPUT"

# Parse result
HAS_ERROR=$(echo "$QR_OUTPUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print('yes' if 'error' in d else 'no')" 2>/dev/null || echo "yes")

if [ "$HAS_ERROR" = "yes" ]; then
  QR_ERROR=$(echo "$QR_OUTPUT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read() or '{}').get('error','unknown'))" 2>/dev/null || echo "parse failed")
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  SMOKE TEST FAILED ✗                                    ║"
  echo "╠══════════════════════════════════════════════════════════╣"
  printf "║  WhatsApp QR RPC failed:\n"
  echo "║  $QR_ERROR"
  echo "╚══════════════════════════════════════════════════════════╝"
  flyctl logs --app "$TEST_APP" --machine-id "$MACHINE_ID" 2>&1 | tail -40
  exit 1
fi

QR_LEN=$(echo "$QR_OUTPUT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read() or '{}').get('qrLength',0))" 2>/dev/null || echo "0")
HAS_QR=$(echo "$QR_OUTPUT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read() or '{}').get('hasQrDataUrl',False))" 2>/dev/null || echo "False")

# ── Final report ─────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SMOKE TEST PASSED ✓                                    ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  WhatsApp QR generated: $HAS_QR"
echo "║  QR data size: $QR_LEN bytes"
echo "║  Baseline startup: ${BASELINE_SECS}s"
echo "║  WhatsApp init: ${WA_SECS}s"
echo "║  Memory baseline: $BASELINE_MEM"
echo "║  Memory + WhatsApp: $WA_MEM"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Pre-release image is safe for production."
echo "To deploy: push to 'main' OR run 'Deploy Blink Claw' workflow with mode=production."
