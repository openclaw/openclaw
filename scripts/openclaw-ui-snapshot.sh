#!/usr/bin/env bash
set -euo pipefail

# OpenClaw UI snapshot bundle (macOS + Peekaboo)
#
# Captures a small, consistent set of artifacts useful for debugging UI state.
# Writes outputs under /tmp so nothing is accidentally committed.
#
# Usage:
#   ./scripts/openclaw-ui-snapshot.sh
#   ./scripts/openclaw-ui-snapshot.sh --out /tmp/my-bundle
#   ./scripts/openclaw-ui-snapshot.sh --capture-engine modern
#   ./scripts/openclaw-ui-snapshot.sh --dry-run
#   ./scripts/openclaw-ui-snapshot.sh --soft-fail
#
# Flags:
#   --out <dir>               Write bundle into a specific directory (must not exist).
#   --capture-engine <engine> Forward to Peekaboo capture (e.g. auto|classic|cg|modern|sckit).
#   --dry-run                 Don’t run peekaboo/openclaw; write a plan + placeholder files.
#   --soft-fail               If peekaboo is missing, exit 0 after writing README.txt.
#   -h|--help                 Show help.

print_usage() {
  sed -n '1,120p' "$0" | sed -n '/^# OpenClaw UI snapshot bundle/,$p' | sed 's/^# \{0,1\}//'
}

out=""
capture_engine=""
dry_run=0
soft_fail=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      out="${2:-}"
      if [[ -z "$out" ]]; then
        echo "Error: --out requires a directory path" >&2
        exit 64
      fi
      shift 2
      ;;
    --capture-engine)
      capture_engine="${2:-}"
      if [[ -z "$capture_engine" ]]; then
        echo "Error: --capture-engine requires a value (auto|classic|cg|modern|sckit)" >&2
        exit 64
      fi
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --soft-fail)
      soft_fail=1
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      echo "Run: $0 --help" >&2
      exit 64
      ;;
  esac
done

ts="$(date +%Y%m%d-%H%M%S)"
if [[ -z "$out" ]]; then
  out="/tmp/openclaw-ui-snapshot-$ts"
fi

if [[ -e "$out" ]]; then
  echo "Error: output path already exists: $out" >&2
  exit 73
fi

mkdir -p "$out"

log="$out/run.log"
err="$out/errors.log"

# Keep logs deterministic/append-only for easy sharing.
: >"$log"
: >"$err"

echo "OpenClaw UI snapshot bundle" >>"$log"
echo "Timestamp: $ts" >>"$log"
echo "Output: $out" >>"$log"

echo "Saved UI snapshot bundle: $out"

have_peekaboo=0
if command -v peekaboo >/dev/null 2>&1; then
  have_peekaboo=1
fi

if [[ $have_peekaboo -eq 0 ]]; then
  cat >"$out/README.txt" <<'EOF'
Peekaboo was not found, so this bundle only includes instructions + logs.

Install Peekaboo:
- brew install steipete/tap/peekaboo

Then grant permissions (required for screenshots + UI maps):
- System Settings -> Privacy & Security -> Screen Recording
  - Enable: Terminal (or iTerm) and Peekaboo/Peekaboo Bridge (if present)
  - Quit and reopen Terminal/iTerm after toggling

- System Settings -> Privacy & Security -> Accessibility
  - Enable: Terminal (or iTerm) and Peekaboo/Peekaboo Bridge (if present)
  - Quit and reopen Terminal/iTerm after toggling

Re-run:
- ./scripts/openclaw-ui-snapshot.sh

If automation is blocked, take manual screenshots:
- Shift-Command-5 -> Capture Selected Window
- Also capture the OpenClaw menubar popover if that's where it lives
EOF

  echo "Note: peekaboo not found; wrote instructions to: $out/README.txt" >&2
  echo "Install with: brew install steipete/tap/peekaboo" >&2

  if [[ $dry_run -eq 1 || $soft_fail -eq 1 ]]; then
    exit 0
  fi
  exit 2
fi

try_out() {
  local desc="$1"; shift
  local file="$1"; shift

  echo "" >>"$log"
  echo "== $desc ==" >>"$log"
  echo "$ $*" >>"$log"

  if [[ $dry_run -eq 1 ]]; then
    printf '%s\n' "$ $*" >"$out/$file"
    echo "SKIPPED (dry-run)" >>"$log"
    return 0
  fi

  if "$@" >"$out/$file" 2>>"$err"; then
    :
  else
    local status=$?
    echo "FAILED: $desc (exit=$status)" >>"$log"
  fi
}

try_cmd() {
  local desc="$1"; shift

  echo "" >>"$log"
  echo "== $desc ==" >>"$log"
  echo "$ $*" >>"$log"

  if [[ $dry_run -eq 1 ]]; then
    echo "SKIPPED (dry-run)" >>"$log"
    return 0
  fi

  if "$@" >>"$log" 2>>"$err"; then
    :
  else
    local status=$?
    echo "FAILED: $desc (exit=$status)" >>"$log"
  fi
}

# Permissions + UI inventory (best-effort; don't fail the whole snapshot if these error).
try_cmd "Peekaboo version" peekaboo --version
try_out "Peekaboo permissions" peekaboo-permissions.txt peekaboo permissions
try_out "Menubar list (json)" menubar.json peekaboo menubar list --json
try_out "Window list (json)" windows.json peekaboo list windows --json

# OpenClaw runtime status (optional, but useful alongside UI artifacts).
if command -v openclaw >/dev/null 2>&1; then
  try_out "OpenClaw status" openclaw-status.txt openclaw status
  try_out "OpenClaw gateway status" openclaw-gateway-status.txt openclaw gateway status
  try_out "OpenClaw channels status (probe)" openclaw-channels-status.txt openclaw channels status --probe
else
  echo "Note: openclaw not found in PATH; skipping CLI status capture" >>"$log"
fi

# Images / UI map (these typically require Screen Recording permission).
# peekaboo writes images to a path; stdout is not meaningful for these.
engine_args=()
if [[ -n "$capture_engine" ]]; then
  engine_args=(--capture-engine "$capture_engine")
  echo "Peekaboo capture engine: $capture_engine" >>"$log"
fi

try_cmd "Screenshot: screen" peekaboo image --mode screen --screen-index 0 --retina "${engine_args[@]}" --path "$out/screen.png"
try_cmd "Screenshot: frontmost" peekaboo image --mode frontmost --retina "${engine_args[@]}" --path "$out/frontmost.png"
try_cmd "UI map: screen (annotated)" peekaboo see --mode screen --screen-index 0 --annotate "${engine_args[@]}" --path "$out/ui-map.png"

# Artifact summary (only list what exists so callers don't have to guess).
echo ""
echo "Artifacts:"
for f in \
  README.txt \
  run.log \
  errors.log \
  peekaboo-permissions.txt \
  menubar.json \
  windows.json \
  openclaw-status.txt \
  openclaw-gateway-status.txt \
  openclaw-channels-status.txt \
  screen.png \
  frontmost.png \
  ui-map.png
do
  if [[ -f "$out/$f" ]]; then
    echo "- $out/$f"
  fi
done

if [[ -s "$err" ]]; then
  echo ""
  echo "Warnings/errors captured in: $err" >&2
fi
