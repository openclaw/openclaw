#!/usr/bin/env bash
# ClaWorks white-label post-deploy verification.
# Checks that no agent-runtime traces are visible from the public edge,
# LLM outbound headers, OTEL, process/container names, and log output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PUBLIC_HOST="${PUBLIC_HOST:-}"
OPENCLAW_UPSTREAM="${OPENCLAW_UPSTREAM:-127.0.0.1:18789}"
CLAWORKS_UPSTREAM="${CLAWORKS_UPSTREAM:-127.0.0.1:8000}"
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── 1. Internal services ─────────────────────────────────────────────────────
hdr "1. Internal services"

if curl -sf --max-time 3 "http://${OPENCLAW_UPSTREAM}/healthz" >/dev/null 2>&1; then
  ok "Agent runtime reachable on ${OPENCLAW_UPSTREAM}"
else
  bad "Agent runtime not reachable at http://${OPENCLAW_UPSTREAM}/healthz"
fi

if curl -sf --max-time 5 "http://${CLAWORKS_UPSTREAM}/v1/health" >/dev/null 2>&1; then
  ok "ClaWorks Platform reachable on ${CLAWORKS_UPSTREAM}"
else
  warn "ClaWorks Platform not reachable at http://${CLAWORKS_UPSTREAM}/v1/health"
fi

if command -v openclaw >/dev/null 2>&1; then
  bind="$(openclaw config get gateway.bind 2>/dev/null || true)"
  if [[ "${bind}" == "loopback" ]]; then
    ok "gateway.bind=loopback"
  else
    bad "gateway.bind=${bind:-unset} — should be loopback for white-label"
  fi
  if openclaw plugins list 2>/dev/null | grep -qi 'bonjour.*disabled\|\[disabled\].*bonjour'; then
    ok "Bonjour plugin disabled"
  else
    warn "Bonjour status unclear — confirm plugins.entries.bonjour.enabled: false"
  fi
fi

# ── 2. Port exposure ─────────────────────────────────────────────────────────
hdr "2. Port exposure (18789 / 8000 must NOT be public)"

for port in 18789 8000 8001; do
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -tlnH "sport = :${port}" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    listeners="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  else
    listeners=""
    warn "Neither ss nor lsof available — skip port ${port}"
    continue
  fi
  if echo "${listeners}" | grep -qE '0\.0\.0\.0|::(?!1)|\*'; then
    bad "Port ${port} bound to 0.0.0.0 / public — rebind to 127.0.0.1 or use firewall"
  elif [[ -n "${listeners}" ]]; then
    ok "Port ${port} loopback/internal only"
  fi
done

# ── 3. Process / container identity ─────────────────────────────────────────
hdr "3. Process / container identity"

# Check process title (NODE_OPTIONS=--title=claworks-agent should be set)
if command -v ps >/dev/null 2>&1; then
  procs_openclaw="$(ps -eo comm,args 2>/dev/null | grep -v grep | grep -i 'openclaw' || true)"
  if [[ -n "${procs_openclaw}" ]]; then
    warn "Found process with 'openclaw' in command line — consider wrapping with NODE_OPTIONS=--title=claworks-agent"
    warn "  ${procs_openclaw}"
  else
    ok "No process exposes 'openclaw' in ps output"
  fi
fi

# Docker: verify container name and service name
if command -v docker >/dev/null 2>&1; then
  containers_openclaw="$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i 'openclaw' || true)"
  if [[ -n "${containers_openclaw}" ]]; then
    bad "Docker container name/image exposes 'openclaw': ${containers_openclaw}"
    bad "  Set AGENT_RUNTIME_IMAGE=claworks-agent:local and use docker-compose.yml service name 'agent-runtime'"
  else
    ok "No Docker container name/image exposes 'openclaw'"
  fi
fi

# State dir should be .claworks, not .openclaw
if command -v openclaw >/dev/null 2>&1; then
  state_dir="$(openclaw config get-env OPENCLAW_STATE_DIR 2>/dev/null || \
               printenv OPENCLAW_STATE_DIR 2>/dev/null || true)"
  if echo "${state_dir}" | grep -qi '\.openclaw'; then
    warn "State dir contains '.openclaw': ${state_dir} — set OPENCLAW_STATE_DIR to .claworks path"
  elif [[ -n "${state_dir}" ]]; then
    ok "State dir: ${state_dir}"
  else
    warn "OPENCLAW_STATE_DIR not set — defaults to ~/.openclaw (may expose name in lsof/proc)"
  fi
fi

# ── 4. Public HTTPS edge ─────────────────────────────────────────────────────
hdr "4. Public HTTPS edge (${PUBLIC_HOST:-<unset>})"

if [[ -z "${PUBLIC_HOST}" ]]; then
  warn "Set PUBLIC_HOST in .env to run public edge checks"
else
  if curl -sf --max-time 5 "https://${PUBLIC_HOST}/healthz" >/dev/null 2>&1; then
    ok "https://${PUBLIC_HOST}/healthz"
  else
    warn "https://${PUBLIC_HOST}/healthz failed (nginx/TLS/DNS?)"
  fi

  if curl -sf --max-time 5 "https://${PUBLIC_HOST}/v1/health" >/dev/null 2>&1; then
    ok "https://${PUBLIC_HOST}/v1/health → ClaWorks Platform"
  else
    warn "https://${PUBLIC_HOST}/v1/health failed"
  fi

  # Response headers
  headers="$(curl -sI --max-time 5 "https://${PUBLIC_HOST}/" 2>/dev/null || true)"

  powered_by="$(echo "${headers}" | grep -i '^x-powered-by:' | tr -d '\r' || true)"
  if echo "${powered_by}" | grep -qi 'claworks'; then
    ok "X-Powered-By: ClaWorks ✓"
  elif echo "${powered_by}" | grep -qi 'openclaw'; then
    bad "X-Powered-By reveals 'openclaw' — Nginx header override not working"
  else
    warn "X-Powered-By missing or unexpected: '${powered_by}'"
  fi

  if echo "${headers}" | grep -qi 'server.*openclaw'; then
    bad "Server header reveals 'openclaw'"
  else
    ok "Server header does not mention 'openclaw'"
  fi

  # Runtime namespace paths must be blocked
  hdr "5. Runtime namespace isolation (must all return 404)"

  for path in "/__openclaw__/" "/openclaw/" "/cw-admin/"; do
    http_code="$(curl -so /dev/null -w '%{http_code}' --max-time 5 \
      "https://${PUBLIC_HOST}${path}" 2>/dev/null || echo 000)"
    if [[ "${http_code}" == "404" ]]; then
      ok "https://${PUBLIC_HOST}${path} → 404 (blocked)"
    elif [[ "${http_code}" == "000" ]]; then
      warn "https://${PUBLIC_HOST}${path} → no response (check DNS/TLS)"
    else
      bad "https://${PUBLIC_HOST}${path} → ${http_code} (should be 404)"
    fi
  done

  # /console/ must be blocked
  console_code="$(curl -so /dev/null -w '%{http_code}' --max-time 5 \
    "https://${PUBLIC_HOST}/console/" 2>/dev/null || echo 000)"
  if [[ "${console_code}" == "404" ]] || [[ "${console_code}" == "403" ]]; then
    ok "https://${PUBLIC_HOST}/console/ → ${console_code} (not publicly accessible)"
  elif [[ "${console_code}" == "000" ]]; then
    warn "https://${PUBLIC_HOST}/console/ → no response"
  else
    bad "https://${PUBLIC_HOST}/console/ → ${console_code} (operator console is publicly accessible!)"
  fi

  # Studio index must not contain 'openclaw'
  body="$(curl -sf --max-time 5 "https://${PUBLIC_HOST}/" 2>/dev/null || true)"
  if echo "${body}" | grep -qi 'openclaw'; then
    bad "Studio index page body contains 'openclaw' — check Studio build / placeholder HTML"
  else
    ok "Studio index page body contains no 'openclaw' string"
  fi
fi

# ── 6. LLM outbound attribution ───────────────────────────────────────────────
hdr "6. LLM outbound attribution header posture"

if command -v openclaw >/dev/null 2>&1; then
  # Inspect configured providers for known public endpoints that send attribution headers
  providers_raw="$(openclaw config get models.providers 2>/dev/null || true)"

  # Check for direct openai.com / anthropic.com / openrouter without custom baseUrl
  if echo "${providers_raw}" | grep -qi '"baseUrl".*api\.openai\.com'; then
    warn "Provider 'openai' uses api.openai.com directly — outbound requests carry"
    warn "  'User-Agent: <runtime>/<ver>' and 'originator: <runtime>' headers visible to OpenAI."
    warn "  To hide: route via a private proxy with a custom baseUrl (endpointClass becomes 'custom')."
  else
    ok "No direct api.openai.com provider detected (custom baseUrl = no attribution headers)"
  fi

  if echo "${providers_raw}" | grep -qi '"baseUrl".*openrouter\.ai\|provider.*openrouter'; then
    # Check if HTTP-Referer override is present
    if echo "${providers_raw}" | grep -qi 'HTTP-Referer.*claworks\|claworks.*HTTP-Referer'; then
      ok "OpenRouter HTTP-Referer override present (claworks)"
    else
      warn "OpenRouter detected without HTTP-Referer override — default referer may expose runtime identity."
      warn "  Add models.providers.openrouter.headers.HTTP-Referer in claworks.json (see fragment)."
    fi
  else
    ok "No direct openrouter.ai provider detected"
  fi
fi

printf '\n'
if [[ "${FAIL}" -eq 0 ]]; then
  ok "All critical white-label checks passed"
  printf '\n  Operator console: ssh -L 18789:127.0.0.1:18789 user@%s\n' "${PUBLIC_HOST:-<host>}"
  printf '  then open: http://localhost:18789/cw-admin/\n\n'
  exit 0
fi
bad "Some checks FAILED — review above"
exit 1
