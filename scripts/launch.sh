#!/usr/bin/env bash
# launch.sh — Build, start, and open the OpenClaw dashboard (local dev)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Config ────────────────────────────────────────────────────────────────────
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"

DASHBOARD_URL="http://localhost:${OPENCLAW_GATEWAY_PORT}"
HEALTHZ_URL="http://localhost:${OPENCLAW_GATEWAY_PORT}/healthz"
CONFIG_FILE="$OPENCLAW_CONFIG_DIR/openclaw.json"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo "  → $*"; }
success() { echo "  ✓ $*"; }
warn()    { echo "  ⚠ $*"; }
die()     { echo "✗ $*" >&2; exit 1; }

# ── Step 1: Ensure config exists ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🦞 OpenClaw — Local Dev Launch"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "[ 1/5 ] Checking config..."

mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
  info "No config found — bootstrapping with gateway.mode=local"
  echo '{}' > "$CONFIG_FILE"
fi

# Ensure gateway.mode=local
if ! python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); sys.exit(0 if d.get('gateway',{}).get('mode')=='local' else 1)" 2>/dev/null; then
  info "Setting gateway.mode=local"
  docker run --rm \
    -v "$OPENCLAW_CONFIG_DIR":/home/node/.openclaw \
    "$OPENCLAW_IMAGE" \
    node dist/index.js config set gateway.mode local 2>/dev/null || \
    warn "Could not set gateway.mode (image may not exist yet — will retry after build)"
fi

# Ensure controlUi origin fallback for local dev
if ! python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); sys.exit(0 if d.get('gateway',{}).get('controlUi',{}).get('dangerouslyAllowHostHeaderOriginFallback') else 1)" 2>/dev/null; then
  info "Setting gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"
  docker run --rm \
    -v "$OPENCLAW_CONFIG_DIR":/home/node/.openclaw \
    "$OPENCLAW_IMAGE" \
    node dist/index.js config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true 2>/dev/null || true
fi

success "Config OK: $CONFIG_FILE"

# ── Step 2: Build image ────────────────────────────────────────────────────────
echo ""
echo "[ 2/5 ] Building Docker image ($OPENCLAW_IMAGE)..."
docker build -t "$OPENCLAW_IMAGE" "$SCRIPT_DIR/.." 2>&1 | tail -3
success "Image built"

# Re-apply config in case the image wasn't available above
docker run --rm \
  -v "$OPENCLAW_CONFIG_DIR":/home/node/.openclaw \
  "$OPENCLAW_IMAGE" \
  node dist/index.js config set gateway.mode local 2>/dev/null || true
docker run --rm \
  -v "$OPENCLAW_CONFIG_DIR":/home/node/.openclaw \
  "$OPENCLAW_IMAGE" \
  node dist/index.js config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true 2>/dev/null || true

# ── Step 3: Read gateway token from config ─────────────────────────────────────
GATEWAY_TOKEN="$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null || true)"
if [[ -z "$GATEWAY_TOKEN" ]]; then
  die "Could not read gateway.auth.token from $CONFIG_FILE — run: openclaw config set gateway.auth.token <token>"
fi
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"
success "Gateway token loaded"

# ── Step 4: Start containers ───────────────────────────────────────────────────
echo ""
echo "[ 3/5 ] Starting containers..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d
success "Containers started"

# ── Step 5: Wait for gateway health ───────────────────────────────────────────
echo ""
echo "[ 4/5 ] Waiting for gateway to be healthy..."
ATTEMPTS=0
MAX_ATTEMPTS=30
until curl -sf "$HEALTHZ_URL" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $ATTEMPTS -ge $MAX_ATTEMPTS ]]; then
    echo ""
    docker compose logs --tail 20 openclaw-gateway
    die "Gateway did not start after ${MAX_ATTEMPTS}s — see logs above"
  fi
  printf "."
  sleep 1
done
echo ""
success "Gateway healthy at $HEALTHZ_URL"

# ── Step 6: Auto-approve first browser pairing request ────────────────────────
echo ""
echo "[ 5/5 ] Opening dashboard and approving device pairing..."
info "Opening $DASHBOARD_URL in your browser..."
open "$DASHBOARD_URL" 2>/dev/null || xdg-open "$DASHBOARD_URL" 2>/dev/null || true

info "Waiting for browser to connect and request pairing (up to 30s)..."
APPROVE_ATTEMPTS=0
APPROVED=false
while [[ $APPROVE_ATTEMPTS -lt 30 ]]; do
  REQUEST_ID="$(docker compose exec -T openclaw-gateway node dist/index.js devices list \
    --url ws://127.0.0.1:18789 \
    --token "$GATEWAY_TOKEN" \
    2>/dev/null \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1 || true)"

  if [[ -n "$REQUEST_ID" ]]; then
    docker compose exec -T openclaw-gateway node dist/index.js devices approve \
      --url ws://127.0.0.1:18789 \
      --token "$GATEWAY_TOKEN" \
      "$REQUEST_ID" 2>/dev/null | grep -v "plugins\|failed\|Cannot\|Require\|- /app" || true
    success "Browser device approved (request: $REQUEST_ID)"
    APPROVED=true
    break
  fi

  printf "."
  sleep 1
  APPROVE_ATTEMPTS=$((APPROVE_ATTEMPTS + 1))
done
echo ""

if [[ "$APPROVED" == false ]]; then
  warn "No pairing request detected within 30s."
  warn "If the dashboard shows 'pairing required', run:"
  echo ""
  echo "  docker compose exec -T openclaw-gateway node dist/index.js devices list \\"
  echo "    --url ws://127.0.0.1:18789 --token $GATEWAY_TOKEN"
  echo ""
  echo "  docker compose exec -T openclaw-gateway node dist/index.js devices approve \\"
  echo "    --url ws://127.0.0.1:18789 --token $GATEWAY_TOKEN <REQUEST_ID>"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Done! Dashboard: $DASHBOARD_URL"
echo "  📋 Logs tab:        $DASHBOARD_URL/logs"
echo "  🔑 Token:           $GATEWAY_TOKEN"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
