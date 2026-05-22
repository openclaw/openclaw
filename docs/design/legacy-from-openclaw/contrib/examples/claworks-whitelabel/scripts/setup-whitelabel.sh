#!/usr/bin/env bash
# One-shot ClaWorks white-label setup (bare metal).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ROOT}/.env.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE} — edit PUBLIC_HOST, TLS paths, then re-run."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

if [[ -z "${PUBLIC_HOST:-}" ]]; then
  echo "Set PUBLIC_HOST in ${ENV_FILE}" >&2
  exit 1
fi

step "1/5 Merge OpenClaw white-label config"
node "${ROOT}/scripts/merge-openclaw-config.mjs" \
  --public-host "${PUBLIC_HOST}" \
  ${CLAWORKS_API_KEY:+--claworks-api-key "${CLAWORKS_API_KEY}"}

step "2/5 Ensure Studio static root"
STUDIO="${STUDIO_STATIC_ROOT:-${ROOT}/studio-dist}"
mkdir -p "${STUDIO}"
if [[ ! -f "${STUDIO}/index.html" ]]; then
  if [[ -f "${ROOT}/studio-dist/index.html" ]]; then
    cp "${ROOT}/studio-dist/index.html" "${STUDIO}/index.html"
    echo "Copied placeholder → ${STUDIO}/index.html"
  else
    echo "Missing ${ROOT}/studio-dist/index.html" >&2
    exit 1
  fi
fi

step "3/5 Render nginx.conf"
chmod +x "${ROOT}/scripts/render-nginx.sh" "${ROOT}/scripts/verify-whitelabel.sh"
"${ROOT}/scripts/render-nginx.sh" "${ENV_FILE}"

step "4/5 Preflight services"
if curl -sf --max-time 3 "http://${OPENCLAW_UPSTREAM:-127.0.0.1:18789}/healthz" >/dev/null 2>&1; then
  echo "OpenClaw Gateway OK at ${OPENCLAW_UPSTREAM:-127.0.0.1:18789}"
else
  echo "OpenClaw Gateway not up yet — run: openclaw gateway restart"
fi
if curl -sf --max-time 5 "http://${CLAWORKS_UPSTREAM:-127.0.0.1:8000}/v1/health" >/dev/null 2>&1; then
  echo "ClaWorks Platform OK at ${CLAWORKS_UPSTREAM:-127.0.0.1:8000}"
else
  echo "ClaWorks Platform not up yet — run: claworks start --port 8000"
fi

step "5/5 Verify (best effort)"
"${ROOT}/scripts/verify-whitelabel.sh" "${ENV_FILE}" || true

cat <<EOF

White-label setup complete.

Install nginx config (requires sudo):
  sudo cp ${ROOT}/nginx/nginx.conf /etc/nginx/conf.d/claworks.conf
  sudo nginx -t && sudo systemctl reload nginx

Feishu Open Platform:
  · Event subscription: WebSocket long connection (no public URL)
  · Configure appId/appSecret in openclaw.json if not set

Operator console (optional, restrict by IP in production):
  https://${PUBLIC_HOST}/console/

Re-verify anytime:
  ${ROOT}/scripts/verify-whitelabel.sh
EOF
