#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  transcribe.sh <audio-file> [--model whisper-1] [--out /path/to/out.txt] [--language en] [--prompt "hint"] [--json]
EOF
  exit 2
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

in="${1:-}"
shift || true

model="whisper-1"
out=""
language=""
prompt=""
response_format="text"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      model="${2:-}"
      shift 2
      ;;
    --out)
      out="${2:-}"
      shift 2
      ;;
    --language)
      language="${2:-}"
      shift 2
      ;;
    --prompt)
      prompt="${2:-}"
      shift 2
      ;;
    --json)
      response_format="json"
      shift 1
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

if [[ ! -f "$in" ]]; then
  echo "File not found: $in" >&2
  exit 1
fi

if [[ "${OPENAI_API_KEY:-}" == "" ]]; then
  echo "Missing OPENAI_API_KEY" >&2
  exit 1
fi

if [[ "$out" == "" ]]; then
  base="${in%.*}"
  if [[ "$response_format" == "json" ]]; then
    out="${base}.json"
  else
    out="${base}.txt"
  fi
fi

mkdir -p "$(dirname "$out")"

curl -sS https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Accept: application/json" \
  -F "file=@${in}" \
  -F "model=${model}" \
  -F "response_format=${response_format}" \
  ${language:+-F "language=${language}"} \
  ${prompt:+-F "prompt=${prompt}"} \
  >"$out"

echo "$out"
