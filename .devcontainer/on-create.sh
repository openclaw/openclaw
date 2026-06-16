#!/usr/bin/env bash
# Post-create setup for the OpenClaw devcontainer.
# Installs project dependencies and coding-agent CLIs.
#
# Security: no host credentials are forwarded via containerEnv.
# Authenticate interactively after creation:
#   gh auth login          — for GitHub CLI / Copilot CLI
#   claude login           — for Claude CLI
# VS Code forwards GitHub auth automatically for the Copilot extension.
set -euo pipefail

echo "==> Installing project dependencies..."
pnpm install

echo ""
echo "==> Setup complete!"
echo ""
echo "  Authenticate when ready:"
echo "    gh auth login        — GitHub CLI + Copilot CLI"
echo "    claude login         — Claude CLI"
echo ""
echo "  GitHub Copilot in VS Code works automatically via the extension."
