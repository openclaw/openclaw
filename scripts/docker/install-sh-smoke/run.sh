#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${QVERISBOT_INSTALL_URL:-${OPENCLAW_INSTALL_URL:-${CLAWDBOT_INSTALL_URL:-https://qveris.ai/qverisbot/install.sh}}}"
SMOKE_PREVIOUS_VERSION="${QVERISBOT_INSTALL_SMOKE_PREVIOUS:-${OPENCLAW_INSTALL_SMOKE_PREVIOUS:-${CLAWDBOT_INSTALL_SMOKE_PREVIOUS:-}}}"
SKIP_PREVIOUS="${QVERISBOT_INSTALL_SMOKE_SKIP_PREVIOUS:-${OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS:-${CLAWDBOT_INSTALL_SMOKE_SKIP_PREVIOUS:-0}}}"
DEFAULT_PACKAGE="@qverisai/qverisbot"
DEFAULT_CLI_NAME="qverisbot"
PACKAGE_NAME="${QVERISBOT_INSTALL_PACKAGE:-${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}}"
CLI_NAME="${QVERISBOT_INSTALL_CLI:-${OPENCLAW_INSTALL_CLI:-$DEFAULT_CLI_NAME}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

echo "==> Resolve npm versions"
LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
if [[ -n "$SMOKE_PREVIOUS_VERSION" ]]; then
  PREVIOUS_VERSION="$SMOKE_PREVIOUS_VERSION"
else
  VERSIONS_JSON="$(npm view "$PACKAGE_NAME" versions --json)"
  PREVIOUS_VERSION="$(VERSIONS_JSON="$VERSIONS_JSON" LATEST_VERSION="$LATEST_VERSION" node - <<'NODE'
const raw = process.env.VERSIONS_JSON || "[]";
const latest = process.env.LATEST_VERSION || "";
let versions;
try {
  versions = JSON.parse(raw);
} catch {
  versions = raw ? [raw] : [];
}
if (!Array.isArray(versions)) {
  versions = [versions];
}
if (versions.length === 0) {
  process.exit(1);
}
const latestIndex = latest ? versions.lastIndexOf(latest) : -1;
if (latestIndex > 0) {
  process.stdout.write(String(versions[latestIndex - 1]));
  process.exit(0);
}
process.stdout.write(String(latest || versions[versions.length - 1]));
NODE
)"
fi

echo "package=$PACKAGE_NAME latest=$LATEST_VERSION previous=$PREVIOUS_VERSION"

if [[ "$SKIP_PREVIOUS" == "1" ]]; then
  echo "==> Skip preinstall previous (QVERISBOT_INSTALL_SMOKE_SKIP_PREVIOUS=1)"
else
  echo "==> Preinstall previous (forces installer upgrade path)"
  npm install -g "${PACKAGE_NAME}@${PREVIOUS_VERSION}"
fi

echo "==> Run official installer one-liner"
curl -fsSL "$INSTALL_URL" | bash

echo "==> Verify installed version"
LATEST_OUT_PATH="${QVERISBOT_INSTALL_LATEST_OUT:-${OPENCLAW_INSTALL_LATEST_OUT:-}}"
if [[ -n "$LATEST_OUT_PATH" ]]; then
  printf "%s" "$LATEST_VERSION" > "$LATEST_OUT_PATH"
fi
CMD_PATH="$(command -v "$CLI_NAME" || true)"
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$CLI_NAME" ]]; then
  CMD_PATH="$HOME/.npm-global/bin/$CLI_NAME"
fi
ENTRY_PATH=""
if [[ -z "$CMD_PATH" ]]; then
  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$NPM_ROOT" && -f "$NPM_ROOT/$PACKAGE_NAME/dist/entry.js" ]]; then
    ENTRY_PATH="$NPM_ROOT/$PACKAGE_NAME/dist/entry.js"
  fi
fi
if [[ -z "$CMD_PATH" && -z "$ENTRY_PATH" ]]; then
  echo "ERROR: $PACKAGE_NAME is not on PATH" >&2
  exit 1
fi
if [[ -n "$CMD_PATH" ]]; then
  INSTALLED_VERSION="$("$CMD_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
else
  INSTALLED_VERSION="$(node "$ENTRY_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
fi
echo "cli=$CLI_NAME installed=$INSTALLED_VERSION expected=$LATEST_VERSION"
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected ${CLI_NAME}@${LATEST_VERSION}, got ${CLI_NAME}@${INSTALLED_VERSION}" >&2
  exit 1
fi
echo "==> Sanity: CLI runs"
if [[ -n "$CMD_PATH" ]]; then
  "$CMD_PATH" --help >/dev/null
else
  node "$ENTRY_PATH" --help >/dev/null
fi

echo "OK"
