#!/usr/bin/env bash
# Deploy OpenClaw + mux-server to Phala CVMs and run smoke tests.
#
# Reads CVM IDs and secrets config from .env.rollout-targets, then:
#   1. Preflight — validate required vault secrets
#   2. Deploy — push compose + env to both CVMs
#   3. Wait — poll until services are healthy
#   4. Smoke test — version, channels, mux registration
#
# Usage:
#   ./phala-deploy/deploy.sh               # full deploy + smoke test
#   ./phala-deploy/deploy.sh --dry-run     # print commands
#   ./phala-deploy/deploy.sh --skip-test   # deploy without smoke test
#   ./phala-deploy/deploy.sh --test-only   # smoke test only (no deploy)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=0
SKIP_TEST=0
TEST_ONLY=0
HEALTH_TIMEOUT=120    # seconds to wait for healthy
HEALTH_INTERVAL=10    # seconds between polls

# ── defaults ─────────────────────────────────────────────────────────────────

OPENCLAW_COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
OPENCLAW_DEPLOY_ENV_FILE="/tmp/openclaw-phala-deploy.env"
OPENCLAW_DEPLOY_SECRETS="MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"

MUX_COMPOSE_FILE="${SCRIPT_DIR}/mux-server-compose.yml"
MUX_DEPLOY_ENV_FILE="/tmp/mux-phala-deploy.env"
MUX_DEPLOY_SECRETS="MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy] !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

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
MUX_HEALTH_URL="https://${MUX_CVM_ID}-18891.${GATEWAY_DOMAIN}/health"
MUX_BASE_URL="https://${MUX_CVM_ID}-18891.${GATEWAY_DOMAIN}"

# ── preflight: validate secrets ──────────────────────────────────────────────

preflight_secrets() {
  log "Preflight: checking vault secrets..."
  local all_secrets="${OPENCLAW_DEPLOY_SECRETS} ${MUX_DEPLOY_SECRETS}"
  # deduplicate
  local unique_secrets
  unique_secrets=$(printf '%s\n' $all_secrets | sort -u | tr '\n' ' ')

  local missing=()
  for key in $unique_secrets; do
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

deploy_role() {
  local role="$1" cvm_id="$2" compose_file="$3" env_file="$4" secrets="$5"
  log "Deploying ${role} (CVM: ${cvm_id})..."

  [[ -f "$compose_file" ]] || die "compose file not found: $compose_file"

  # Render secrets from vault to env file
  local rv_tmp="${env_file}.rvtmp"
  local rv_cmd=(rv-exec --dotenv "$rv_tmp")
  # shellcheck disable=SC2206
  rv_cmd+=($secrets)
  rv_cmd+=(-- bash -lc "cp '$rv_tmp' '$env_file' && chmod 600 '$env_file'")

  if (( DRY_RUN )); then
    log "[dry-run] ${rv_cmd[*]}"
    [[ "$role" == "openclaw" ]] && generate_openclaw_config "$env_file"
    log "[dry-run] phala deploy --cvm-id $cvm_id -c $compose_file -e $env_file"
    return 0
  fi

  "${rv_cmd[@]}"
  rm -f "$rv_tmp"

  if [[ "$role" == "openclaw" ]]; then
    generate_openclaw_config "$env_file"
  fi

  phala deploy --cvm-id "$cvm_id" -c "$compose_file" -e "$env_file"
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

  # 2. openclaw --version
  log "  openclaw --version..."
  local version
  version="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'openclaw --version' 2>/dev/null)" || true
  if [[ -n "$version" ]]; then
    ok "  openclaw version: ${version}"
  else
    warn "  openclaw --version failed"
    failures=$((failures + 1))
  fi

  # 3. openclaw channels status --probe (gateway reachable?)
  log "  openclaw channels status --probe..."
  local channels_output
  channels_output="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" 'openclaw channels status --probe' 2>/dev/null)" || true
  if [[ "$channels_output" == *"Gateway reachable"* ]]; then
    ok "  gateway reachable"
  else
    warn "  gateway not reachable"
    # Print channels output for debugging
    printf '%s\n' "$channels_output" | head -5 >&2
    failures=$((failures + 1))
  fi

  # 4. mux config check (registerKey + inboundUrl present)
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

  # 5. mux registration probe (can we register/re-register with mux-server?)
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

deploy_role "openclaw" "$OPENCLAW_CVM_ID" "$OPENCLAW_COMPOSE_FILE" \
  "$OPENCLAW_DEPLOY_ENV_FILE" "$OPENCLAW_DEPLOY_SECRETS"

deploy_role "mux" "$MUX_CVM_ID" "$MUX_COMPOSE_FILE" \
  "$MUX_DEPLOY_ENV_FILE" "$MUX_DEPLOY_SECRETS"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry-run complete."
  exit 0
fi

log "Both CVMs updated. Waiting for services..."
wait_for_mux_health
wait_for_openclaw_ssh

if [[ "$SKIP_TEST" -eq 0 ]]; then
  smoke_test
fi

log "Deploy complete."
