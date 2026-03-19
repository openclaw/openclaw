#!/bin/bash
set -euo pipefail

# OpenFinClaw Plugin Publisher
# Publishes @openfinclaw/openfinclaw to npm
#
# Usage:
#   export NPM_TOKEN=npm_xxxxx
#   pnpm plugins:publish:openfinclaw
#
# Required: NPM_TOKEN (Granular Access Token with 2FA bypass enabled)

PLUGIN_NAME="@openfinclaw/openfinclaw-strategy"

echo "OpenFinClaw Plugin Publisher"
echo "============================="
echo ""

# Check NPM_TOKEN
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "Error: NPM_TOKEN environment variable is required."
  echo ""
  echo "Create a Granular Access Token at:"
  echo "  https://www.npmjs.com/settings/YOUR_USERNAME/tokens/granular-access-tokens/new"
  echo ""
  echo "Token settings:"
  echo "  - Packages: Read and write"
  echo "  - Organizations: @openfinclaw"
  echo "  - Enable: Bypass 2FA for automation"
  echo ""
  echo "Then run:"
  echo "  export NPM_TOKEN=npm_xxxxx"
  echo "  pnpm plugins:publish:openfinclaw"
  exit 1
fi

# Create .npmrc with token for publishing
NPMRC_BACKUP="${HOME}/.npmrc.backup.$$"
if [ -f "${HOME}/.npmrc" ]; then
  cp "${HOME}/.npmrc" "$NPMRC_BACKUP"
fi

cleanup() {
  if [ -f "$NPMRC_BACKUP" ]; then
    mv "$NPMRC_BACKUP" "${HOME}/.npmrc"
  else
    rm -f "${HOME}/.npmrc"
  fi
}
trap cleanup EXIT

# Write npmrc with token
cat > "${HOME}/.npmrc" << NPMRC
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
@openfinclaw:registry=https://registry.npmjs.org/
NPMRC

# Verify auth
echo "Verifying npm authentication..."
if ! npm whoami &>/dev/null; then
  echo "Error: npm authentication failed. Check your NPM_TOKEN."
  exit 1
fi

echo "Logged in as: $(npm whoami)"
echo ""

# Install dependencies
echo "Installing dependencies..."
pnpm install
echo ""

# Publish
echo "Publishing ${PLUGIN_NAME}..."
if pnpm --filter "${PLUGIN_NAME}" publish --access public --no-git-checks; then
  echo ""
  echo "✓ ${PLUGIN_NAME} published successfully"
else
  echo ""
  echo "⚠ Publishing may have failed or package already published"
fi

echo ""
echo "==========================================="
echo "Verifying..."
version=$(npm view "${PLUGIN_NAME}" version 2>/dev/null || echo "NOT FOUND")
echo "  ${PLUGIN_NAME}: ${version}"