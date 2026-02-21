#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  frame.sh <video-file> [--time HH:MM:SS | --index N] --out /path/to/frame.jpg
EOF
  exit 2
}

[[ $# -eq 0 || "${1:-}" =~ ^(-h|--help)$ ]] && usage

command -v ffmpeg >/dev/null 2>&1 || {
  echo "Error: ffmpeg not found" >&2
  exit 127
}

in="$1"
shift

time=""
index=""
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time)
      [[ $# -ge 2 ]] || { echo "--time requires value" >&2; exit 2; }
      time="$2"
      shift 2
      ;;
    --index)
      [[ $# -ge 2 ]] || { echo "--index requires value" >&2; exit 2; }
      index="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || { echo "--out requires value" >&2; exit 2; }
      out="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

[[ -f "$in" ]] || { echo "File not found: $in" >&2; exit 1; }
[[ -n "$out" ]] || { echo "Missing --out" >&2; exit 2; }

[[ -n "$time" && -n "$index" ]] && {
  echo "Use either --time or --index, not both" >&2
  exit 2
}

[[ -n "$index" && ! "$index" =~ ^[0-9]+$ ]] && {
  echo "--index must be a non-negative integer" >&2
  exit 2
}

mkdir -p "$(dirname "$out")"

if [[ -n "$index" ]]; then
  ffmpeg -hide_banner -loglevel error -y \
    -i "$in" \
    -vf "select=eq(n\\,${index})" \
    -frames:v 1 \
    "$out"
elif [[ -n "$time" ]]; then
  ffmpeg -hide_banner -loglevel error -y \
    -i "$in" -ss "$time" \
    -frames:v 1 \
    "$out"
else
  ffmpeg -hide_banner -loglevel error -y \
    -i "$in" \
    -vf "select=eq(n\\,0)" \
    -frames:v 1 \
    "$out"
fi

[[ -f "$out" ]] && echo "$out"
