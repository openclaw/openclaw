#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.openclaw"
TOKEN_FILE=""

resolve_gh_binary() {
  if command -v gh >/dev/null 2>&1; then
    command -v gh
    return 0
  fi
  for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh /usr/bin/gh; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-dir)
      CONFIG_DIR="$2"
      shift 2
      ;;
    --token-file)
      TOKEN_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TOKEN_FILE" ]]; then
  TOKEN_FILE="${CONFIG_DIR}/identity/github-token"
fi

GH_BIN="$(resolve_gh_binary || true)"
if [[ -z "$GH_BIN" ]]; then
  exit 0
fi

TOKEN="$("$GH_BIN" auth token 2>/dev/null || true)"
TOKEN="${TOKEN//$'\r'/}"
TOKEN="${TOKEN//$'\n'/}"
if [[ -z "$TOKEN" ]]; then
  exit 0
fi

mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ -f "$TOKEN_FILE" ]]; then
  EXISTING="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"
  if [[ "$EXISTING" == "$TOKEN" ]]; then
    exit 0
  fi
fi

TMP_FILE="$(mktemp "$(dirname "$TOKEN_FILE")/github-token.XXXXXX")"
printf '%s\n' "$TOKEN" >"$TMP_FILE"
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$TOKEN_FILE"
