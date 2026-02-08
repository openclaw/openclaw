#!/usr/bin/env bash
set -euo pipefail

# Visual readiness probe for OpenClaw (macOS).
# - If Peekaboo permissions are missing, prints exact steps to fix.
# - If permissions are granted, captures a small snapshot bundle under /tmp.

if ! command -v peekaboo >/dev/null 2>&1; then
  echo "Peekaboo is not installed. Install with:"
  echo "  brew install steipete/tap/peekaboo"
  exit 1
fi

echo "== Peekaboo permissions =="
perm_out="$(peekaboo permissions 2>&1 || true)"
echo "$perm_out"

if echo "$perm_out" | grep -Fq "Screen Recording (Required): Not Granted"; then
  cat <<'EOF'

== Fix: grant Screen Recording (exact macOS steps) ==
1) Open System Settings
2) Privacy & Security → Screen Recording
3) Enable:
   - Your terminal app (Terminal or iTerm)
   - Peekaboo (and/or Peekaboo Bridge), if it appears
4) Quit & reopen the terminal app (permission is per running instance)
5) If Peekaboo Bridge is running, quit & relaunch it too
6) Re-run: peekaboo permissions

Once Screen Recording is enabled, Peekaboo can:
- Capture screenshots (whole screen, frontmost window)
- Generate annotated UI maps with element IDs (peekaboo see --annotate)
- Inspect window/app state visually (list windows + see snapshot IDs)
EOF
  exit 2
fi

if echo "$perm_out" | grep -Fq "Accessibility (Required): Not Granted"; then
  cat <<'EOF'

== Fix: grant Accessibility (exact macOS steps) ==
1) Open System Settings
2) Privacy & Security → Accessibility
3) Enable:
   - Your terminal app (Terminal or iTerm)
   - Peekaboo (and/or Peekaboo Bridge), if it appears
4) Quit & reopen the terminal app
5) If Peekaboo Bridge is running, quit & relaunch it too
6) Re-run: peekaboo permissions

Once Accessibility is enabled, Peekaboo can:
- Click/type/press keys reliably (click/type/press/hotkey)
- Drive menus/menubar and focus windows (menu/menubar/window)
- Interact with specific UI elements by ID (from the annotated UI map)
EOF
  exit 3
fi

ts="$(date +%Y%m%d-%H%M%S)"
out="/tmp/openclaw-ui-snapshot-$ts"
mkdir -p "$out"

echo ""
echo "== Capturing snapshot bundle =="
# Prefer `peekaboo list ...` for stable JSON flags.
peekaboo list menubar --json > "$out/menubar.json" || true

# Best-effort: list windows for the active app (if we can detect it).
active_bundle_id="$(
  (peekaboo app list --json 2>/dev/null || true) | python3 -c '
import json,sys
s=sys.stdin.read().strip()
if not s:
  raise SystemExit(0)
j=json.loads(s)
apps=(j.get("data") or {}).get("apps") or []
for a in apps:
  if a.get("is_active") and a.get("bundle_id"):
    print(a["bundle_id"])
    break
'
)"
if [ -n "${active_bundle_id:-}" ]; then
  peekaboo list windows --app "$active_bundle_id" --include-details bounds,ids --json > "$out/windows.json" || true
else
  : > "$out/windows.json"
fi

# Fast/high-signal artifacts for debugging state.
peekaboo image --mode frontmost --retina --path "$out/frontmost.png"
peekaboo see --mode screen --screen-index 0 --annotate --path "$out/ui-map.png"

# Optional: whole screen (bigger, but sometimes useful).
peekaboo image --mode screen --screen-index 0 --retina --path "$out/screen.png" || true

echo "Saved: $out"
