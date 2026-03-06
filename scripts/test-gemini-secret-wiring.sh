#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/jpow/openclaw}"
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-docker-compose.secrets-canary.yml}"
SERVICE_NAME="${SERVICE_NAME:-openclaw-gateway-secrets}"
SECRET_HOST_PATH="${SECRET_HOST_PATH:-/home/jpow/.openclaw/secrets/gemini_api_key}"
RUNTIME_CHECK="${RUNTIME_CHECK:-0}"
CHECK_NOTION=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-notion)
      CHECK_NOTION=1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

have_noninteractive_sudo() {
  command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1
}

have_tty() {
  [ -t 0 ] && [ -t 1 ]
}

cd "$PROJECT_DIR"

echo "[1/4] Validating compose config includes gemini secret mapping..."
CONFIG_RENDERED="$(docker compose -f docker-compose.yml -f "$COMPOSE_OVERRIDE" config)"
printf '%s\n' "$CONFIG_RENDERED" | grep -q 'GEMINI_API_KEY_PATH: /run/secrets/gemini_api_key'
printf '%s\n' "$CONFIG_RENDERED" | grep -q 'gemini_api_key:'

if [ "$CHECK_NOTION" = "1" ]; then
  printf '%s\n' "$CONFIG_RENDERED" | grep -q 'NOTION_API_KEY_PATH: /run/secrets/notion_api_key'
  printf '%s\n' "$CONFIG_RENDERED" | grep -q 'notion_api_key:'
fi

secret_file_ok=0
if [ -s "$SECRET_HOST_PATH" ]; then
  secret_file_ok=1
elif have_noninteractive_sudo && sudo -n test -s "$SECRET_HOST_PATH"; then
  secret_file_ok=1
elif have_tty && command -v sudo >/dev/null 2>&1; then
  echo "INFO: sudo credentials required to validate root-owned secret file: $SECRET_HOST_PATH"
  if sudo test -s "$SECRET_HOST_PATH"; then
    secret_file_ok=1
  fi
fi

if [ "$secret_file_ok" -ne 1 ]; then
  if [ -e "$SECRET_HOST_PATH" ] || (have_noninteractive_sudo && sudo -n test -e "$SECRET_HOST_PATH"); then
    echo "FAIL: secret file exists but is unreadable by current user (and sudo validation did not succeed): $SECRET_HOST_PATH" >&2
  else
    echo "FAIL: missing or empty secret file: $SECRET_HOST_PATH" >&2
  fi
  exit 1
fi

echo "[2/4] Host secret file exists and is non-empty..."

echo "[3/4] Verifying secrets entrypoint requires GEMINI_API_KEY..."
grep -q 'require_secret GEMINI_API_KEY GEMINI_API_KEY_PATH' entrypoint-secrets.sh

if [ "$CHECK_NOTION" = "1" ]; then
  echo "[3/4] Verifying secrets entrypoint requires NOTION_API_KEY..."
  grep -q 'require_secret NOTION_API_KEY NOTION_API_KEY_PATH' entrypoint-secrets.sh

  notion_secret_ok=0
  notion_secret_host_path="/home/jpow/.openclaw/secrets/notion_api_key"
  if [ -s "$notion_secret_host_path" ]; then
    notion_secret_ok=1
  elif have_noninteractive_sudo && sudo -n test -s "$notion_secret_host_path"; then
    notion_secret_ok=1
  elif have_tty && command -v sudo >/dev/null 2>&1; then
    echo "INFO: sudo credentials required to validate root-owned secret file: $notion_secret_host_path"
    if sudo test -s "$notion_secret_host_path"; then
      notion_secret_ok=1
    fi
  fi

  if [ "$notion_secret_ok" -ne 1 ]; then
    if [ -e "$notion_secret_host_path" ] || (have_noninteractive_sudo && sudo -n test -e "$notion_secret_host_path"); then
      echo "FAIL: notion secret file exists but is unreadable by current user (and sudo validation did not succeed): $notion_secret_host_path" >&2
    else
      echo "FAIL: missing or empty notion secret file: $notion_secret_host_path" >&2
    fi
    exit 1
  fi
fi

if [ "$RUNTIME_CHECK" = "1" ]; then
  echo "[4/4] Running runtime check inside container..."
  CONTAINER_ID="$(docker compose -f docker-compose.yml -f "$COMPOSE_OVERRIDE" ps -q "$SERVICE_NAME" || true)"
  if [ -z "$CONTAINER_ID" ]; then
    echo "FAIL: service '$SERVICE_NAME' is not running. Start it first with docker compose up -d $SERVICE_NAME, or run with RUNTIME_CHECK=0." >&2
    exit 1
  fi

  if ! docker exec "$CONTAINER_ID" sh -lc 'tr "\0" "\n" </proc/1/environ | grep -q "^GEMINI_API_KEY=."'; then
    echo "FAIL: GEMINI_API_KEY not found in /proc/1/environ for service '$SERVICE_NAME'" >&2
    exit 1
  fi

  if [ "$CHECK_NOTION" = "1" ]; then
    if ! docker exec "$CONTAINER_ID" sh -lc 'tr "\0" "\n" </proc/1/environ | grep -q "^NOTION_API_KEY=."'; then
      echo "FAIL: NOTION_API_KEY not found in /proc/1/environ for service '$SERVICE_NAME'" >&2
      exit 1
    fi
  fi
else
  echo "[4/4] Skipping runtime container env check (set RUNTIME_CHECK=1 to enable)."
fi

echo "PASS: Secret wiring checks succeeded"
