#!/usr/bin/env bash
# Deploy OpenClaw to a Phala CVM and run smoke tests.
#
# Reads CVM IDs from .env.rollout-targets (needs both — mux CVM ID is used
# to derive MUX_BASE_URL for config generation).
#
# Secrets (via rv-exec --dotenv):
#   MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION
#   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
# Also needs MUX_REGISTER_KEY for gen-cvm-config.sh (via rv-exec).
#
# Usage:
#   rv-exec MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
#     AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY MUX_REGISTER_KEY \
#     -- bash phala-deploy/deploy-openclaw.sh
#
#   bash phala-deploy/deploy-openclaw.sh --dry-run
#   bash phala-deploy/deploy-openclaw.sh --skip-test
#   bash phala-deploy/deploy-openclaw.sh --test-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_TEST=0
TEST_ONLY=0
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=10

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
DEPLOY_ENV_FILE="/tmp/openclaw-phala-deploy.env"
DEPLOY_SECRETS="MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[deploy-openclaw]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-openclaw] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy-openclaw] !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy-openclaw] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

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
  GATEWAY_DOMAIN="$(resolve_gateway_domain "$OPENCLAW_CVM_ID")" \
    || die "failed to resolve gateway domain from CVM ${OPENCLAW_CVM_ID}"
  ok "Gateway domain: ${GATEWAY_DOMAIN}"
else
  GATEWAY_DOMAIN="<gateway-domain>"
fi

CVM_SSH_HOST="${OPENCLAW_CVM_ID}-1022.${GATEWAY_DOMAIN}"
MUX_BASE_URL="https://${MUX_CVM_ID}-18891.${GATEWAY_DOMAIN}"

# ── preflight: validate secrets ──────────────────────────────────────────────

preflight_secrets() {
  log "Preflight: checking vault secrets..."
  local missing=()
  for key in $DEPLOY_SECRETS MUX_REGISTER_KEY; do
    if ! rv-exec "$key" -- true 2>/dev/null; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing vault secrets: ${missing[*]}\nRun: rv set <KEY> for each missing secret"
  fi
  ok "All vault secrets present"
}

# ── generate openclaw config ─────────────────────────────────────────────────

generate_openclaw_config() {
  local env_file="$1"
  log "Generating OPENCLAW_CONFIG_B64..."

  if (( DRY_RUN )); then
    log "[dry-run] rv-exec MASTER_KEY MUX_REGISTER_KEY -- gen-cvm-config.sh >> $env_file"
    return 0
  fi

  rv-exec MASTER_KEY MUX_REGISTER_KEY -- bash -lc '
    export MUX_BASE_URL="'"$MUX_BASE_URL"'"
    cfg=$("'"$SCRIPT_DIR"'/gen-cvm-config.sh")
    echo "OPENCLAW_CONFIG_B64=${cfg}" >> "'"$env_file"'"
  '
  ok "OPENCLAW_CONFIG_B64 appended to $env_file"
}

# ── deploy ───────────────────────────────────────────────────────────────────

deploy() {
  log "Deploying OpenClaw (CVM: ${OPENCLAW_CVM_ID})..."

  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

  # Render secrets from vault to env file
  local rv_tmp="${DEPLOY_ENV_FILE}.rvtmp"
  local rv_cmd=(rv-exec --dotenv "$rv_tmp")
  # shellcheck disable=SC2206
  rv_cmd+=($DEPLOY_SECRETS)
  rv_cmd+=(-- bash -lc "cp '$rv_tmp' '$DEPLOY_ENV_FILE' && chmod 600 '$DEPLOY_ENV_FILE'")

  if (( DRY_RUN )); then
    log "[dry-run] ${rv_cmd[*]}"
    generate_openclaw_config "$DEPLOY_ENV_FILE"
    log "[dry-run] phala deploy --cvm-id $OPENCLAW_CVM_ID -c $COMPOSE_FILE -e $DEPLOY_ENV_FILE"
    return 0
  fi

  "${rv_cmd[@]}"
  rm -f "$rv_tmp"

  generate_openclaw_config "$DEPLOY_ENV_FILE"

  phala deploy --cvm-id "$OPENCLAW_CVM_ID" -c "$COMPOSE_FILE" -e "$DEPLOY_ENV_FILE"
}

# ── wait for health ──────────────────────────────────────────────────────────

wait_for_openclaw_ssh() {
  log "Waiting for OpenClaw SSH (${CVM_SSH_HOST})..."
  local elapsed=0
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'true' >/dev/null 2>&1; then
      ok "OpenClaw SSH reachable"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done
  die "OpenClaw SSH not reachable after ${HEALTH_TIMEOUT}s"
}

# ── smoke test ───────────────────────────────────────────────────────────────

smoke_test() {
  log "Running smoke tests..."
  local failures=0

  # 1. openclaw --version
  log "  openclaw --version..."
  local version
  version="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'openclaw --version' 2>/dev/null)" || true
  if [[ -n "$version" ]]; then
    ok "  openclaw version: ${version}"
  else
    warn "  openclaw --version failed"
    failures=$((failures + 1))
  fi

  # 2. openclaw channels status --probe (gateway reachable?)
  log "  openclaw channels status --probe..."
  local channels_output
  channels_output="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'openclaw channels status --probe' 2>/dev/null)" || true
  if [[ "$channels_output" == *"Gateway reachable"* ]]; then
    ok "  gateway reachable"
  else
    warn "  gateway not reachable"
    printf '%s\n' "$channels_output" | head -5 >&2
    failures=$((failures + 1))
  fi

  # 3. mux config check (registerKey + inboundUrl present)
  log "  openclaw mux config..."
  local mux_config
  mux_config="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'node -e "
    const fs = require(\"fs\");
    const cfg = JSON.parse(fs.readFileSync(\"/root/.openclaw/openclaw.json\", \"utf8\"));
    const m = cfg.gateway?.http?.endpoints?.mux || {};
    const ok = m.enabled && m.baseUrl && m.registerKey && m.inboundUrl;
    console.log(JSON.stringify({
      enabled: !!m.enabled,
      hasBaseUrl: !!m.baseUrl,
      hasRegisterKey: !!m.registerKey,
      hasInboundUrl: !!m.inboundUrl,
      ok: !!ok
    }));
  "' 2>/dev/null)" || true
  if [[ "$mux_config" == *'"ok":true'* ]]; then
    ok "  mux config complete"
  else
    warn "  mux config incomplete: ${mux_config}"
    failures=$((failures + 1))
  fi

  # 4. mux registration probe
  log "  mux registration probe..."
  local device_id
  device_id="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'node -e "
    const fs = require(\"fs\");
    try {
      const d = JSON.parse(fs.readFileSync(\"/root/.openclaw/identity/device.json\", \"utf8\"));
      process.stdout.write(d.deviceId);
    } catch { process.exit(1); }
  "' 2>/dev/null)" || true

  if [[ -z "$device_id" ]]; then
    warn "  could not read device ID"
    failures=$((failures + 1))
  else
    local register_url="${MUX_BASE_URL}/v1/instances/register"
    local inbound_url="https://${OPENCLAW_CVM_ID}-18789.${GATEWAY_DOMAIN}/v1/mux/inbound"
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

log "CVM updated. Waiting for OpenClaw..."
wait_for_openclaw_ssh

if [[ "$SKIP_TEST" -eq 0 ]]; then
  smoke_test
fi

log "Deploy complete."
