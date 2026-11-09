#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  transcribe.sh <audio-file> [--model gpt-4o-transcribe] [--out /path/to/out.txt] [--language en] [--prompt "hint"] [--json]
EOF
  exit 2
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

in="${1:-}"
shift || true

model="gpt-4o-transcribe"
out=""
language=""
prompt=""
json_output=0

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
      json_output=1
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
  base="$in"
  name="${in##*/}"
  # Strip a suffix only when the basename has an extension after any leading dotfile dot.
  if [[ "$name" == *.* && "${name#.}" == *.* ]]; then
    base="${in%.*}"
  fi
  if [[ "$json_output" == "1" ]]; then
    out="${base}.json"
  else
    out="${base}.txt"
  fi
fi

mkdir -p -- "$(dirname -- "$out")"

# Reject predictable output failures before making a paid request.
if [[ -d "$out" || ( -e "$out" && ! -w "$out" ) || ( ! -e "$out" && ! -w "$(dirname -- "$out")" ) ]]; then
  echo "Cannot write output to $out. Choose a writable file with --out." >&2
  exit 1
fi

api_base="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
api_base="${api_base%/}"

request_format="text"
if [[ "$json_output" == "1" ]]; then
  request_format="json"
fi

diarize=0
case "$model" in
  gpt-4o-transcribe | gpt-4o-mini-transcribe | gpt-4o-mini-transcribe-*)
    request_format="json"
    ;;
  gpt-4o-transcribe-diarize)
    diarize=1
    request_format="diarized_json"
    ;;
esac

if [[ "$diarize" == "1" && "$prompt" != "" ]]; then
  echo "--prompt is not supported with gpt-4o-transcribe-diarize" >&2
  exit 2
fi

# Preserve existing output until the response has downloaded successfully.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Quote the filename for curl's form parser, including literal quotes and backslashes.
upload_path="${in//\\/\\\\}"
upload_path="${upload_path//\"/\\\"}"
curl_args=(
  -fsS "${api_base}/audio/transcriptions"
  -H "Authorization: Bearer $OPENAI_API_KEY"
  -H "Accept: application/json"
  -F "file=@\"${upload_path}\""
  -F "model=${model}"
  -F "response_format=${request_format}"
)
if [[ "$language" != "" ]]; then
  curl_args+=(-F "language=${language}")
fi
if [[ "$prompt" != "" ]]; then
  curl_args+=(--form-string "prompt=${prompt}")
fi
if [[ "$diarize" == "1" ]]; then
  curl_args+=(-F "chunking_strategy=auto")
fi

curl "${curl_args[@]}" >"$tmp"

if [[ "$json_output" == "0" && ( "$request_format" == "json" || "$request_format" == "diarized_json" ) ]]; then
  node -e '
const fs = require("fs");
const input = process.argv[1];
const output = process.argv[2];
const payload = JSON.parse(fs.readFileSync(input, "utf8"));
if (Array.isArray(payload.segments)) {
  const lines = payload.segments
    .map((segment) => {
      const text = typeof segment?.text === "string" ? segment.text.trim() : "";
      if (!text) return "";
      const speaker = typeof segment?.speaker === "string" ? segment.speaker.trim() : "";
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean);
  if (lines.length > 0) {
    fs.writeFileSync(output, lines.join("\n"));
    process.exit(0);
  }
}
if (typeof payload.text !== "string") {
  throw new Error("Transcription response missing text");
}
fs.writeFileSync(output, payload.text);
' "$tmp" "$out"
else
  cat "$tmp" >"$out"
fi

echo "$out"
