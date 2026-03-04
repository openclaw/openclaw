#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"

echo "==> Setup unsupported Node fixture (Node 20 via nvm)"
export NVM_DIR="$HOME/.nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

set +u
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
set -u

nvm install 20
nvm use 20

echo "==> Verify precondition (node 20 active)"
NODE_VERSION="$(node -v)"
NPM_VERSION="$(npm -v)"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
echo "node=$NODE_VERSION npm=$NPM_VERSION"
echo "node_bin=$NODE_BIN npm_bin=$NPM_BIN"
if [[ "$NODE_VERSION" != v20.* ]]; then
  echo "ERROR: expected Node 20 before installer run" >&2
  exit 1
fi

echo "==> Run installer one-liner in shell with unsupported default node"
curl -fsSL "$INSTALL_URL" | bash

echo "==> Verify installed CLI works despite node 20 shell default"
EXPECTED_VERSION="${OPENCLAW_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: $PACKAGE_NAME is not on PATH" >&2
  exit 1
fi

CLI_PATH="$(command -v openclaw)"
INSTALLED_VERSION="$(openclaw --version 2>/dev/null | head -n 1 | tr -d '\r')"
echo "cli=$CLI_PATH installed=$INSTALLED_VERSION expected=$LATEST_VERSION"
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected openclaw@$LATEST_VERSION, got openclaw@$INSTALLED_VERSION" >&2
  exit 1
fi

openclaw config set gateway.mode local >/dev/null
echo "==> Sanity: CLI commands work"
openclaw --help >/dev/null

echo "OK"
