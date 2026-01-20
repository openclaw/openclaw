#!/usr/bin/env bash
# Shared library for building macOS releases
# Usage: source this file and call build_mac_release_worktree

# Build macOS companion app from a specific release version
#
# Parameters:
#   $1 - VERSION: Release tag (e.g., v2026.1.15)
#   $2 - APPLY_HOTFIXES: "true" to apply hotfixes, "false" to skip
#
# This function:
#   1. Creates a fresh worktree at .worktrees/latest from the specified release tag
#   2. Optionally applies all hotfix/* branches that aren't already in the release
#   3. Builds the macOS companion app (Clawdbot.app) only - does NOT build CLI
#   4. Outputs to .worktrees/latest/dist/Clawdbot.app
#
# Note: This is destructive - removes existing .worktrees/latest on each run

build_mac_release_worktree() {
  local VERSION="${1:-}"
  local APPLY_HOTFIXES="${2:-false}"

  if [[ -z "$VERSION" ]]; then
    echo "Error: VERSION is required" >&2
    return 1
  fi

  local REPO_ROOT
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local LATEST_DIR="$REPO_ROOT/.worktrees/latest"

  if [[ "$APPLY_HOTFIXES" == "true" ]]; then
    echo "🚀 Building Clawdbot $VERSION (with hotfixes)"
  else
    echo "🚀 Building clean Clawdbot $VERSION (no hotfixes)"
  fi
  echo ""

  cd "$REPO_ROOT"

  # Remove existing 'latest' worktree if it exists
  if [[ -d "$LATEST_DIR" ]]; then
    echo "🧹 Removing existing 'latest' worktree..."
    git worktree remove "$LATEST_DIR" --force 2>/dev/null || rm -rf "$LATEST_DIR"
    echo ""
  fi

  # Create worktree at 'latest' using the tag (detached HEAD)
  if git rev-parse --verify --quiet "$VERSION" >/dev/null; then
    echo "📂 Creating worktree 'latest' from tag $VERSION (detached HEAD)..."
    git worktree add --detach "$LATEST_DIR" "$VERSION"
  else
    echo "❌ Error: Tag '$VERSION' does not exist"
    echo "   Available tags: $(git tag | grep '^v2026' | tail -5 | tr '\n' ' ')"
    return 1
  fi
  echo ""

  # Navigate to worktree
  cd "$LATEST_DIR"
  echo "📍 Working directory: $(pwd)"
  echo ""

  # Initialize submodules (required for Peekaboo and its dependencies)
  if [[ ! -d "Peekaboo/Core/PeekabooCore" ]]; then
    echo "📦 Initializing submodules..."
    git submodule update --init --recursive
    echo ""
  fi

  # Apply hotfixes if requested
  if [[ "$APPLY_HOTFIXES" == "true" ]]; then
    # Apply fixes using the smart apply script
    # This auto-detects which fixes are needed based on what's already in the target
    if [[ -f "$REPO_ROOT/scripts/apply-release-fixes.sh" ]]; then
      "$REPO_ROOT/scripts/apply-release-fixes.sh"
      echo ""
    else
      echo "⚠️  apply-release-fixes.sh not found, skipping fix application"
      echo ""
    fi
  else
    echo "ℹ️  Skipping hotfix application (clean build)"
    echo ""
  fi

  # Install dependencies if needed
  if [[ ! -d "node_modules" ]]; then
    echo "📦 Installing dependencies..."
    pnpm self-update
    pnpm install
    echo ""
  fi

  # Build
  echo "🔨 Building app..."
  BUILD_ARCHS="arm64" \
  DISABLE_LIBRARY_VALIDATION=1 \
  ./scripts/package-mac-app.sh

  echo ""
  if [[ "$APPLY_HOTFIXES" == "true" ]]; then
    echo "✅ Build complete!"
  else
    echo "✅ Clean build complete!"
  fi
  echo ""

  echo "Build location: $LATEST_DIR/dist/Clawdbot.app"
  if [[ "$APPLY_HOTFIXES" == "true" ]]; then
    echo "Version: $VERSION"
  else
    echo "Version: $VERSION (clean, no hotfixes)"
  fi
  echo ""
  echo "Next steps:"
  echo "1. Switch to admin account"
  echo "2. Run: ./scripts/deploy-release.sh"
  echo ""
}
