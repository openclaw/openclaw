#!/usr/bin/env bash
# Deploy mux-server to a Phala CVM and run smoke tests.
#
# Reads CVM IDs from .env.rollout-targets (needs both — openclaw CVM ID is
# used for the registration probe smoke test).
#
# Secrets (via rv-exec):
#   MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD
#
# The _PROD tokens are mapped to the compose-expected names:
#   TELEGRAM_BOT_TOKEN_PROD → TELEGRAM_BOT_TOKEN
#   DISCORD_BOT_TOKEN_PROD  → DISCORD_BOT_TOKEN
#
# Usage:
#   rv-exec MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD \
#     -- bash phala-deploy/deploy-mux.sh
#
#   bash phala-deploy/deploy-mux.sh --dry-run
#   bash phala-deploy/deploy-mux.sh --skip-test
#   bash phala-deploy/deploy-mux.sh --test-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_TEST=0
TEST_ONLY=0
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=10

COMPOSE_FILE="${SCRIPT_DIR}/mux-server-compose.yml"
DEPLOY_ENV_FILE="/tmp/mux-phala-deploy.env"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[deploy-mux]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-mux] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy-mux] !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy-mux] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ── parse args ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --skip-test) SKIP_TEST=1; shift ;;
    --test-only) TEST_ONLY=1; shift ;;
    --timeout)   HEALTH_TIMEOUT="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ── load config ──────────────────────────────────────────────────────────────

ENV_FILE="${SCRIPT_DIR}/.env.rollout-targets"
[[ -f "$ENV_FILE" ]] || die "config not found: ${ENV_FILE}\nCopy cvm-rollout-targets.env.example to .env.rollout-targets and fill in CVM IDs."
set -a; source "$ENV_FILE"; set +a

OPENCLAW_CVM_ID="${PHALA_OPENCLAW_CVM_IDS:?set PHALA_OPENCLAW_CVM_IDS in .env.rollout-targets}"
MUX_CVM_ID="${PHALA_MUX_CVM_IDS:?set PHALA_MUX_CVM_IDS in .env.rollout-targets}"

require_cmd phala
require_cmd rv-exec
require_cmd curl
require_cmd node

# ── resolve gateway domain ───────────────────────────────────────────────────

resolve_gateway_domain() {
  phala cvms get "$1" --json 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(d).gateway.base_domain); }
      catch { process.exit(1); }
    });'
}

if [[ "$DRY_RUN" -eq 0 ]]; then
  log "Resolving gateway domain..."
  GATEWAY_DOMAIN="$(resolve_gateway_domain "$MUX_CVM_ID")" \
    || die "failed to resolve gateway domain from CVM ${MUX_CVM_ID}"
  ok "Gateway domain: ${GATEWAY_DOMAIN}"
else
  GATEWAY_DOMAIN="<gateway-domain>"
fi

MUX_HEALTH_URL="https://${MUX_CVM_ID}-18891.${GATEWAY_DOMAIN}/health"
MUX_BASE_URL="https://${MUX_CVM_ID}-18891.${GATEWAY_DOMAIN}"

# ── preflight: validate secrets ──────────────────────────────────────────────

preflight_secrets() {
  log "Preflight: checking vault secrets..."
  local missing=()
  for key in MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD; do
    if ! rv-exec "$key" -- true 2>/dev/null; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing vault secrets: ${missing[*]}\nRun: rv set <KEY> for each missing secret"
  fi
  ok "All vault secrets present"
}

# ── deploy ───────────────────────────────────────────────────────────────────

deploy() {
  log "Deploying mux-server (CVM: ${MUX_CVM_ID})..."

  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

  if (( DRY_RUN )); then
    log "[dry-run] rv-exec MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD -- write env"
    log "[dry-run] phala deploy --cvm-id $MUX_CVM_ID -c $COMPOSE_FILE -e $DEPLOY_ENV_FILE"
    return 0
  fi

  # Map _PROD tokens to compose-expected names
  rv-exec MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN_PROD DISCORD_BOT_TOKEN_PROD \
    -- bash -c '
    cat > "'"$DEPLOY_ENV_FILE"'" <<EOF
MUX_REGISTER_KEY=${MUX_REGISTER_KEY}
MUX_ADMIN_TOKEN=${MUX_ADMIN_TOKEN}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN_PROD}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN_PROD}
EOF
    chmod 600 "'"$DEPLOY_ENV_FILE"'"
  '

  phala deploy --cvm-id "$MUX_CVM_ID" -c "$COMPOSE_FILE" -e "$DEPLOY_ENV_FILE"
}

# ── wait for health ──────────────────────────────────────────────────────────

wait_for_mux_health() {
  log "Waiting for mux-server health (${MUX_HEALTH_URL})..."
  local elapsed=0
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if curl -fsS --max-time 5 "$MUX_HEALTH_URL" >/dev/null 2>&1; then
      ok "mux-server healthy"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done
  die "mux-server not healthy after ${HEALTH_TIMEOUT}s"
}

# ── smoke test ───────────────────────────────────────────────────────────────

smoke_test() {
  log "Running smoke tests..."
  local failures=0

  # 1. mux-server /health
  log "  mux-server /health..."
  local mux_body
  mux_body="$(curl -fsS --max-time 10 "$MUX_HEALTH_URL" 2>&1)" || true
  if [[ "$mux_body" == *'"ok":true'* ]]; then
    ok "  mux-server /health -> ok"
  else
    warn "  mux-server /health failed: ${mux_body}"
    failures=$((failures + 1))
  fi

  # 2. mux registration probe (needs openclaw CVM to read device ID)
  log "  mux registration probe..."

  # Resolve openclaw gateway for SSH + registration
  local oc_gateway
  if [[ "$DRY_RUN" -eq 0 ]]; then
    oc_gateway="$(resolve_gateway_domain "$OPENCLAW_CVM_ID")" || true
  else
    oc_gateway="<gateway-domain>"
  fi

  if [[ -z "$oc_gateway" ]]; then
    warn "  could not resolve openclaw gateway — skipping registration probe"
    failures=$((failures + 1))
  else
    local cvm_ssh_host="${OPENCLAW_CVM_ID}-1022.${oc_gateway}"
    local device_id
    device_id="$(CVM_SSH_HOST="$cvm_ssh_host" "$SCRIPT_DIR/cvm-exec" 'node -e "
      const fs = require(\"fs\");
      try {
        const d = JSON.parse(fs.readFileSync(\"/root/.openclaw/identity/device.json\", \"utf8\"));
        process.stdout.write(d.deviceId);
      } catch { process.exit(1); }
    "' 2>/dev/null)" || true

    if [[ -z "$device_id" ]]; then
      warn "  could not read device ID from openclaw CVM"
      failures=$((failures + 1))
    else
      local register_url="${MUX_BASE_URL}/v1/instances/register"
      local inbound_url="https://${OPENCLAW_CVM_ID}-18789.${oc_gateway}/v1/mux/inbound"
      local register_code
      register_code="$(rv-exec --project openclaw MUX_REGISTER_KEY -- bash -c '
        curl -o /dev/null -sS -w "%{http_code}" --max-time 10 \
          "'"${register_url}"'" \
          -X POST \
          -H "Authorization: Bearer ${MUX_REGISTER_KEY}" \
          -H "Content-Type: application/json" \
          -d "{\"openclawId\":\"'"${device_id}"'\",\"inboundUrl\":\"'"${inbound_url}"'\"}"
      ' 2>/dev/null)" || true
      if [[ "$register_code" == "200" ]]; then
        ok "  mux registration: device ${device_id:0:12}... registered (HTTP 200)"
      else
        warn "  mux registration failed: HTTP ${register_code}"
        failures=$((failures + 1))
      fi
    fi
  fi

  # summary
  echo ""
  if [[ $failures -eq 0 ]]; then
    ok "All smoke tests passed"
  else
    die "${failures} smoke test(s) failed"
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

if [[ "$TEST_ONLY" -eq 1 ]]; then
  smoke_test
  exit 0
fi

preflight_secrets
deploy

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry-run complete."
  exit 0
fi

log "CVM updated. Waiting for mux-server..."
wait_for_mux_health

if [[ "$SKIP_TEST" -eq 0 ]]; then
  smoke_test
fi

log "Deploy complete."
