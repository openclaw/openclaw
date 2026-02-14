#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${QVERISBOT_INSTALL_URL:-${OPENCLAW_INSTALL_URL:-${CLAWDBOT_INSTALL_URL:-https://qveris.ai/qverisbot/install.sh}}}"
DEFAULT_PACKAGE="@qverisai/qverisbot"
DEFAULT_CLI_NAME="qverisbot"
PACKAGE_NAME="${QVERISBOT_INSTALL_PACKAGE:-${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}}"
CLI_NAME="${QVERISBOT_INSTALL_CLI:-${OPENCLAW_INSTALL_CLI:-$DEFAULT_CLI_NAME}}"

echo "==> Pre-flight: ensure git absent"
if command -v git >/dev/null; then
  echo "git is present unexpectedly" >&2
  exit 1
fi

echo "==> Run installer (non-root user)"
curl -fsSL "$INSTALL_URL" | bash

# Ensure PATH picks up user npm prefix
export PATH="$HOME/.npm-global/bin:$PATH"

echo "==> Verify git installed"
command -v git >/dev/null

EXPECTED_VERSION="${QVERISBOT_INSTALL_EXPECT_VERSION:-${OPENCLAW_INSTALL_EXPECT_VERSION:-}}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
fi
CMD_PATH="$(command -v "$CLI_NAME" || true)"
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$CLI_NAME" ]]; then
  CMD_PATH="$HOME/.npm-global/bin/$CLI_NAME"
fi
if [[ -z "$CMD_PATH" ]]; then
  echo "$PACKAGE_NAME is not on PATH" >&2
  exit 1
fi
echo "==> Verify CLI installed: $CLI_NAME"
INSTALLED_VERSION="$("$CMD_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"

echo "cli=$CLI_NAME installed=$INSTALLED_VERSION expected=$LATEST_VERSION"
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected ${CLI_NAME}@${LATEST_VERSION}, got ${CLI_NAME}@${INSTALLED_VERSION}" >&2
  exit 1
fi

echo "==> Sanity: CLI runs"
"$CMD_PATH" --help >/dev/null

echo "OK"
