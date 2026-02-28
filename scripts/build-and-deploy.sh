#!/usr/bin/env bash
# Build OpenClaw from fork and install globally, then restart gateway.
# Usage: bash scripts/build-and-deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "📦 Pulling latest from origin..."
git pull --ff-only origin main

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "🔨 Building..."
pnpm build

echo "🚀 Installing globally..."
sudo npm install -g . --install-links 2>/dev/null || sudo npm install -g .

echo "✅ Version: $(openclaw --version)"

echo "🔄 Restarting gateway..."
openclaw gateway restart

echo "😸 Done!"
