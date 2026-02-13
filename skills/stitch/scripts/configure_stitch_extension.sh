#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Create ~/.gemini/extensions/Stitch/gemini-extension.json for Stitch extension auth.

Usage:
  configure_stitch_extension.sh --auth apikey [--api-key <key>] [--output <path>] [--force]
  configure_stitch_extension.sh --auth adc [--project-id <id>] [--output <path>] [--force]

Env fallback:
  STITCH_API_KEY     Used when --auth apikey and --api-key is omitted
  STITCH_PROJECT_ID  Used when --auth adc and --project-id is omitted
USAGE
  exit 2
}

auth=""
api_key=""
project_id=""
output="${HOME}/.gemini/extensions/Stitch/gemini-extension.json"
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auth)
      auth="${2:-}"
      shift 2
      ;;
    --api-key)
      api_key="${2:-}"
      shift 2
      ;;
    --project-id)
      project_id="${2:-}"
      shift 2
      ;;
    --output)
      output="${2:-}"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$auth" ]]; then
  echo "Missing required --auth (apikey|adc)" >&2
  usage
fi

json_escape() {
  local s="${1:-}"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

case "$auth" in
  apikey)
    if [[ -z "$api_key" ]]; then
      api_key="${STITCH_API_KEY:-}"
    fi
    if [[ -z "$api_key" ]]; then
      echo "Missing API key. Set STITCH_API_KEY or pass --api-key." >&2
      exit 1
    fi
    ;;
  adc)
    if [[ -z "$project_id" ]]; then
      project_id="${STITCH_PROJECT_ID:-}"
    fi
    if [[ -z "$project_id" ]]; then
      echo "Missing project id. Set STITCH_PROJECT_ID or pass --project-id." >&2
      exit 1
    fi
    ;;
  *)
    echo "Invalid --auth: $auth (expected apikey|adc)" >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$output")"

if [[ -e "$output" && $force -ne 1 ]]; then
  echo "Refusing to overwrite existing file: $output" >&2
  echo "Use --force to overwrite." >&2
  exit 1
fi

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [[ "$auth" == "apikey" ]]; then
  escaped_key="$(json_escape "$api_key")"
  cat >"$tmp" <<JSON
{
  "name": "Stitch",
  "version": "0.1.4",
  "description": "Integrate Stitch into your workflow: Generate UI from Text, Image.",
  "mcpServers": {
    "stitch": {
      "httpUrl": "https://stitch.googleapis.com/mcp",
      "headers": {
        "X-Goog-Api-Key": "$escaped_key"
      },
      "timeout": 300000
    }
  }
}
JSON
else
  escaped_project_id="$(json_escape "$project_id")"
  cat >"$tmp" <<JSON
{
  "name": "Stitch",
  "version": "0.1.4",
  "description": "Integrate Stitch into your workflow: Generate UI from Text, Image.",
  "mcpServers": {
    "stitch": {
      "httpUrl": "https://stitch.googleapis.com/mcp",
      "authProviderType": "google_credentials",
      "oauth": {
        "scopes": [
          "https://www.googleapis.com/auth/cloud_platform"
        ]
      },
      "headers": {
        "X-Goog-User-Project": "$escaped_project_id"
      },
      "timeout": 300000
    }
  }
}
JSON
fi

mv "$tmp" "$output"
chmod 600 "$output"

echo "$output"
