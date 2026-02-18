#!/usr/bin/env bash
# E2E test for Composio MCP credential injection pipeline.
#
# Two modes:
#   --offline   Config pipeline only (no Docker, no backend). Default.
#   --live      Full stack: build image, start backend, boot container,
#               verify mcporter connects to real Composio via proxy.
#
# Prerequisites (offline): node, mcporter (or npx)
# Prerequisites (live):    above + docker, uv, clawdi backend/.env with
#                          COMPOSIO_API_KEY and ENCRYPTION_KEY
#
# Usage:
#   ./scripts/e2e/composio-inject-docker.sh              # offline only
#   ./scripts/e2e/composio-inject-docker.sh --live        # offline + live
#   ./scripts/e2e/composio-inject-docker.sh --live-only   # live only (skip offline)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEPLOY_DIR="${ROOT_DIR}/phala-deploy"
CLAWDI_BACKEND_DIR="${CLAWDI_BACKEND_DIR:-$(cd "${ROOT_DIR}/../claw/clawdi/backend" 2>/dev/null && pwd || echo "")}"

MODE="offline"  # offline | live | live-only
CONTAINER_NAME="openclaw-composio-e2e"
IMAGE_NAME="openclaw-e2e-test"
BACKEND_PID=""

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; }
log()  { printf '\033[1;34m[test]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[test] FATAL:\033[0m %s\n' "$*" >&2; exit 2; }

# ── parse args ────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)      MODE="live"; shift ;;
    --live-only) MODE="live-only"; shift ;;
    --offline)   MODE="offline"; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ── cleanup ───────────────────────────────────────────────────────────────────

WORKDIR=$(mktemp -d)

cleanup() {
  # Stop backend if we started it
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    log "Backend stopped (PID $BACKEND_PID)"
  fi
  # Remove test container
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  # Remove temp dir
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════════════════
# OFFLINE TESTS — config pipeline (no Docker, no backend)
# ══════════════════════════════════════════════════════════════════════════════

run_offline_tests() {
  log "═══ Offline tests: gen-cvm-config.sh produces valid config ═══"

  export MASTER_KEY="test-e2e-master-key"
  export MUX_BASE_URL="http://mux-server:18891"
  export MUX_REGISTER_KEY="test-e2e-register-key"

  # Step 1: gen-cvm-config.sh produces base64 output
  log "Step 1: gen-cvm-config.sh → OPENCLAW_CONFIG_B64"
  local config_b64
  config_b64=$("$DEPLOY_DIR/gen-cvm-config.sh" 2>&1)
  if [[ -n "$config_b64" ]]; then
    ok "gen-cvm-config.sh produced output (${#config_b64} chars)"
  else
    fail "gen-cvm-config.sh produced empty output"
    return
  fi

  # Step 2: Decode and verify essential fields
  log "Step 2: base64 decode → valid openclaw.json"
  local config_file="$WORKDIR/openclaw.json"
  printf '%s' "$config_b64" | base64 -d > "$config_file"

  if [[ -s "$config_file" ]]; then
    ok "Decoded to openclaw.json ($(wc -c < "$config_file") bytes)"
  else
    fail "Decoded file is empty"
    return
  fi

  # Verify gateway auth and mux config are present
  local has_gateway has_mux
  has_gateway=$(node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$config_file', 'utf8'));
    process.stdout.write(cfg.gateway?.auth?.token ? 'yes' : 'no');
  ")
  has_mux=$(node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$config_file', 'utf8'));
    process.stdout.write(cfg.gateway?.http?.endpoints?.mux?.enabled ? 'yes' : 'no');
  ")

  [[ "$has_gateway" == "yes" ]] \
    && ok "Gateway auth token present" \
    || fail "Gateway auth token missing"

  [[ "$has_mux" == "yes" ]] \
    && ok "Mux endpoint configured" \
    || fail "Mux endpoint missing"
}

# ══════════════════════════════════════════════════════════════════════════════
# LIVE TESTS — Docker + backend + real Composio
# ══════════════════════════════════════════════════════════════════════════════

run_live_tests() {
  log "═══ Live tests: Docker + backend + Composio ═══"

  # ── Preflight ─────────────────────────────────────────────────────────────
  command -v docker >/dev/null 2>&1 || die "docker required for live tests"
  command -v uv >/dev/null 2>&1    || die "uv required for live tests"
  [[ -n "$CLAWDI_BACKEND_DIR" && -f "$CLAWDI_BACKEND_DIR/.env" ]] \
    || die "Clawdi backend .env not found (set CLAWDI_BACKEND_DIR)"

  # Check required keys in backend .env
  local has_composio has_encryption
  has_composio=$(grep -c "^COMPOSIO_API_KEY=.\+" "$CLAWDI_BACKEND_DIR/.env" || true)
  has_encryption=$(grep -c "^ENCRYPTION_KEY=.\+" "$CLAWDI_BACKEND_DIR/.env" || true)
  [[ "$has_composio" -ge 1 ]]  || die "COMPOSIO_API_KEY not set in $CLAWDI_BACKEND_DIR/.env"
  [[ "$has_encryption" -ge 1 ]] || die "ENCRYPTION_KEY not set in $CLAWDI_BACKEND_DIR/.env"

  # ── Step 1: Build Docker image ────────────────────────────────────────────
  log "Step 1: Build Docker image"
  docker build --target base -t "$IMAGE_NAME" -f "$DEPLOY_DIR/Dockerfile" "$ROOT_DIR" \
    > "$WORKDIR/docker-build.log" 2>&1 \
    || { cat "$WORKDIR/docker-build.log"; die "Docker build failed"; }
  ok "Docker image built ($IMAGE_NAME)"

  # ── Step 2: Start backend (with test endpoints enabled) ──────────────────
  log "Step 2: Start Clawdi backend"
  pkill -9 -f "uvicorn app.main" 2>/dev/null || true
  sleep 1

  (cd "$CLAWDI_BACKEND_DIR" && ENABLE_TEST_ENDPOINTS=true BACKEND_BASE_URL=http://host.docker.internal:8000 uv run uvicorn app.main:app --host 0.0.0.0 --port 8000) \
    > "$WORKDIR/backend.log" 2>&1 &
  BACKEND_PID=$!

  # Wait for backend health
  local elapsed=0
  while [[ $elapsed -lt 30 ]]; do
    if curl -sf http://127.0.0.1:8000/docs >/dev/null 2>&1; then break; fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if curl -sf http://127.0.0.1:8000/docs >/dev/null 2>&1; then
    ok "Backend running on :8000 (PID $BACKEND_PID)"
  else
    tail -10 "$WORKDIR/backend.log" >&2
    die "Backend failed to start"
  fi

  # ── Step 3: Build config via backend + start container ──────────────────
  log "Step 3: POST /internal/build-config → start container"
  local build_resp
  build_resp=$(curl -sf --max-time 10 \
    -X POST http://127.0.0.1:8000/internal/build-config \
    -H "Content-Type: application/json" \
    -d '{"clerk_id":"user_test_e2e"}')

  if [[ -z "$build_resp" ]]; then
    die "POST /internal/build-config returned empty response"
  fi

  local config_b64 master_key
  config_b64=$(printf '%s' "$build_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(d).config_b64))")
  master_key=$(printf '%s' "$build_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(d).master_key))")

  if [[ -n "$config_b64" ]]; then
    ok "Config built via backend (${#config_b64} chars)"
  else
    die "config_b64 empty in build-config response"
  fi

  # Verify composio env is present in the config
  local has_composio_env
  has_composio_env=$(printf '%s' "$config_b64" | base64 -d | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const cfg=JSON.parse(d);
      const env=cfg.skills?.entries?.composio?.env||{};
      process.stdout.write(env.COMPOSIO_MCP_URL&&env.COMPOSIO_MCP_TOKEN?'yes':'no');
    })")
  [[ "$has_composio_env" == "yes" ]] \
    && ok "Config includes skills.entries.composio.env" \
    || fail "Config missing composio env (COMPOSIO_API_KEY set in backend?)"

  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  docker run -d \
    --name "$CONTAINER_NAME" \
    --privileged \
    --add-host=host.docker.internal:host-gateway \
    -e MASTER_KEY="$master_key" \
    -e OPENCLAW_CONFIG_B64="$config_b64" \
    -e DSTACK_APP_ID=test-app \
    -e DSTACK_GATEWAY_DOMAIN=test.phala.network \
    "$IMAGE_NAME" \
    > /dev/null

  # Wait for entrypoint to complete config setup
  local wait_elapsed=0 container_logs=""
  while [[ $wait_elapsed -lt 30 ]]; do
    container_logs=$(docker logs "$CONTAINER_NAME" 2>&1) || true
    if echo "$container_logs" | grep -q "mcporter config written"; then break; fi
    sleep 1
    wait_elapsed=$((wait_elapsed + 1))
  done

  if echo "$container_logs" | grep -q "mcporter config written"; then
    ok "Container booted, mcporter config written"
  else
    echo "$container_logs" | head -10 >&2
    fail "Entrypoint did not write mcporter config"
    return
  fi

  # ── Step 4: mcporter connects to real Composio ──────────────────────────
  log "Step 4: mcporter list (proves full pipeline)"

  local list_out
  list_out=$(docker exec "$CONTAINER_NAME" mcporter list 2>&1) || true

  if echo "$list_out" | grep -qP '\d+ tools'; then
    ok "mcporter connects: $(echo "$list_out" | grep -oP '\d+ tools')"
  else
    fail "mcporter list failed: $list_out"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if [[ "$MODE" != "live-only" ]]; then
  run_offline_tests
fi

if [[ "$MODE" == "live" || "$MODE" == "live-only" ]]; then
  echo ""
  run_live_tests
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
log "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  printf '\033[1;32m[test] All tests passed.\033[0m\n'
  exit 0
else
  printf '\033[1;31m[test] %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
