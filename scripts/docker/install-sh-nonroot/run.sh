#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${DNA_INSTALL_URL:-https://molt.bot/install.sh}"
DEFAULT_PACKAGE="dna"
if [[ -z "${DNA_INSTALL_PACKAGE:-}" && "$INSTALL_URL" == *"clawd.bot"* ]]; then
  DEFAULT_PACKAGE="dna"
fi
PACKAGE_NAME="${DNA_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"
if [[ "$PACKAGE_NAME" == "dna" ]]; then
  ALT_PACKAGE_NAME="dna"
else
  ALT_PACKAGE_NAME="dna"
fi

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

EXPECTED_VERSION="${DNA_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
fi
CLI_NAME="$PACKAGE_NAME"
CMD_PATH="$(command -v "$CLI_NAME" || true)"
if [[ -z "$CMD_PATH" ]]; then
  CLI_NAME="$ALT_PACKAGE_NAME"
  CMD_PATH="$(command -v "$CLI_NAME" || true)"
fi
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$PACKAGE_NAME" ]]; then
  CLI_NAME="$PACKAGE_NAME"
  CMD_PATH="$HOME/.npm-global/bin/$PACKAGE_NAME"
fi
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$ALT_PACKAGE_NAME" ]]; then
  CLI_NAME="$ALT_PACKAGE_NAME"
  CMD_PATH="$HOME/.npm-global/bin/$ALT_PACKAGE_NAME"
fi
if [[ -z "$CMD_PATH" ]]; then
  echo "Neither $PACKAGE_NAME nor $ALT_PACKAGE_NAME is on PATH" >&2
  exit 1
fi
if [[ -z "$EXPECTED_VERSION" && "$CLI_NAME" != "$PACKAGE_NAME" ]]; then
  LATEST_VERSION="$(npm view "$CLI_NAME" version)"
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
