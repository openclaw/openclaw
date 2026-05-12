#!/usr/bin/env bash
# HyperFrames setup for OpenClaw.
#
# Verifies Node >= 22 and FFmpeg, installs the `hyperframes` CLI globally,
# pre-caches `chrome-headless-shell`, and runs `hyperframes doctor`.
#
# Pins `hyperframes@>=0.4.2` so the OpenClaw/Chromium-147 fix from
# https://github.com/heygen-com/hyperframes/issues/294 (commit 4c72ba4)
# is always present — the engine auto-detects `HeadlessExperimental.beginFrame`
# support and falls back to screenshot capture otherwise.
#
# Idempotent: safe to re-run.

set -euo pipefail

MIN_NODE_MAJOR=22
MIN_HYPERFRAMES_VERSION="0.4.2"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

bold "==> HyperFrames setup"

# --- 1. Node.js --------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  red "✗ Node.js is not installed."
  echo "   Install Node.js >= ${MIN_NODE_MAJOR} (nvm, Homebrew, or your package manager) and re-run."
  exit 1
fi

node_version="$(node --version | sed 's/^v//')"
node_major="$(echo "$node_version" | cut -d. -f1)"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  red "✗ Node.js ${node_version} is too old. HyperFrames requires Node.js >= ${MIN_NODE_MAJOR}."
  echo "   Upgrade with 'nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}' or your package manager."
  exit 1
fi
green "✓ Node.js ${node_version}"

# --- 2. FFmpeg ---------------------------------------------------------------

if ! command -v ffmpeg >/dev/null 2>&1; then
  red "✗ FFmpeg is not installed."
  case "$(uname -s)" in
    Linux*)   echo "   sudo apt-get install -y ffmpeg   # Debian/Ubuntu"
              echo "   sudo dnf install -y ffmpeg       # Fedora/RHEL";;
    Darwin*)  echo "   brew install ffmpeg";;
    MINGW*|MSYS*|CYGWIN*) echo "   winget install Gyan.FFmpeg";;
    *)        echo "   See https://ffmpeg.org/download.html";;
  esac
  exit 1
fi
green "✓ FFmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# --- 3. npm ------------------------------------------------------------------

if ! command -v npm >/dev/null 2>&1; then
  red "✗ npm is not installed (should ship with Node.js)."
  exit 1
fi

# --- 4. Install / upgrade hyperframes CLI -----------------------------------

bold "==> Installing hyperframes CLI (>= ${MIN_HYPERFRAMES_VERSION})"

current_hyperframes=""
if command -v hyperframes >/dev/null 2>&1; then
  current_hyperframes="$(hyperframes --version 2>/dev/null | tail -1 | sed 's/^v//')"
fi

if [ -n "$current_hyperframes" ]; then
  yellow "   Found hyperframes ${current_hyperframes}"
fi

# Always install/upgrade to >= MIN version.
# Using 'latest' so we pick up any newer auto-detect/capture fixes.
if ! npm install -g "hyperframes@latest" >/dev/null 2>&1; then
  red "✗ npm install -g hyperframes@latest failed."
  echo "   Try: sudo npm install -g hyperframes@latest"
  echo "   Or use a user-scoped npm prefix: npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  exit 1
fi

installed_version="$(hyperframes --version 2>/dev/null | tail -1 | sed 's/^v//')"
green "✓ hyperframes ${installed_version} installed globally"

# Sanity-check minimum version.
version_ge() {
  # version_ge A B  →  true if A >= B
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}
if ! version_ge "$installed_version" "$MIN_HYPERFRAMES_VERSION"; then
  red "✗ hyperframes ${installed_version} is below required minimum ${MIN_HYPERFRAMES_VERSION}."
  echo "   Try 'npm install -g hyperframes@latest' or 'sudo npm install -g hyperframes@latest'."
  exit 1
fi

# --- 5. Pre-cache chrome-headless-shell --------------------------------------
#
# Chromium 147+ removed HeadlessExperimental.beginFrame. System Chrome (e.g.
# /usr/bin/google-chrome) can't render with the fast path, so the engine
# auto-detects and falls back to screenshot mode — but BeginFrame mode is
# faster and produces higher-quality output. Install chrome-headless-shell
# up front so the engine picks it over system Chrome.

bold "==> Pre-caching chrome-headless-shell (for best render quality)"

if ! npx --yes puppeteer browsers install chrome-headless-shell >/dev/null 2>&1; then
  yellow "⚠ Could not pre-install chrome-headless-shell."
  yellow "  Rendering will still work via screenshot-mode fallback (slower)."
  yellow "  If you hit HeadlessExperimental.beginFrame errors:"
  yellow "     export PRODUCER_FORCE_SCREENSHOT=true"
  yellow "  See references/troubleshooting.md."
else
  green "✓ chrome-headless-shell installed"
fi

# --- 6. Doctor ---------------------------------------------------------------

bold "==> Running hyperframes doctor"

if hyperframes doctor; then
  green "✓ HyperFrames is ready"
  echo
  echo "   Scaffold a project:   npx hyperframes init my-video"
  echo "   Preview:              npx hyperframes preview"
  echo "   Render:               npx hyperframes render"
else
  yellow "⚠ hyperframes doctor reported issues."
  yellow "  See references/troubleshooting.md or re-run 'hyperframes doctor'."
  exit 1
fi
