#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZIP=${1:?"Usage: $0 Clawdbot-<ver>.zip"}
FEED_URL=${2:-"https://raw.githubusercontent.com/clawdbot/clawdbot/main/appcast.xml"}
PRIVATE_KEY_FILE=${SPARKLE_PRIVATE_KEY_FILE:-}
if [[ -z "$PRIVATE_KEY_FILE" ]]; then
  echo "Set SPARKLE_PRIVATE_KEY_FILE to your ed25519 private key (Sparkle)." >&2
  exit 1
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Zip not found: $ZIP" >&2
  exit 1
fi

ZIP_DIR=$(cd "$(dirname "$ZIP")" && pwd)
ZIP_NAME=$(basename "$ZIP")
ZIP_BASE="${ZIP_NAME%.zip}"
VERSION=${SPARKLE_RELEASE_VERSION:-}
if [[ -z "$VERSION" ]]; then
  if [[ "$ZIP_NAME" =~ ^Clawdbot-([0-9]+(\.[0-9]+){1,2}([-.][^.]*)?)\.zip$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $ZIP_NAME; set SPARKLE_RELEASE_VERSION." >&2
    exit 1
  fi
fi

NOTES_HTML="${ZIP_DIR}/${ZIP_BASE}.html"
KEEP_NOTES=${KEEP_SPARKLE_NOTES:-0}
if [[ -x "$ROOT/scripts/changelog-to-html.sh" ]]; then
  "$ROOT/scripts/changelog-to-html.sh" "$VERSION" >"$NOTES_HTML"
else
  echo "Missing scripts/changelog-to-html.sh; cannot generate HTML release notes." >&2
  exit 1
fi
if [[ "$KEEP_NOTES" != "1" ]]; then
  trap 'rm -f "$NOTES_HTML"' EXIT
fi

DOWNLOAD_URL_PREFIX=${SPARKLE_DOWNLOAD_URL_PREFIX:-"https://github.com/clawdbot/clawdbot/releases/download/v${VERSION}/"}

export PATH="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin:$PATH"
if ! command -v generate_appcast >/dev/null; then
  echo "generate_appcast not found in PATH. Build Sparkle tools via SwiftPM." >&2
  exit 1
fi

generate_appcast \
  --ed-key-file "$PRIVATE_KEY_FILE" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "$ZIP_DIR"

echo "Appcast generated (appcast.xml). Upload alongside $ZIP at $FEED_URL"
