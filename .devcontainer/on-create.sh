#!/usr/bin/env bash
# Post-create setup for the OpenClaw devcontainer.
# Installs dependencies and verifies authentication.
set -euo pipefail

echo "==> Installing dependencies..."
pnpm install

echo ""
echo "==> Checking authentication..."

ok=0
warn=0

# ── GitHub CLI ───────────────────────────────────────────────────
if gh auth status >/dev/null 2>&1; then
  echo "  ✓ GitHub CLI: authenticated"
  ok=$((ok + 1))

  # Install GitHub Copilot extension (requires auth, so done here).
  if gh copilot --version >/dev/null 2>&1; then
    echo "  ✓ GitHub Copilot: already installed"
  else
    echo "    Installing GitHub Copilot gh extension..."
    if gh extension install github/gh-copilot 2>/dev/null; then
      echo "  ✓ GitHub Copilot: installed"
    else
      echo "  ✗ GitHub Copilot: install failed (can retry with 'gh extension install github/gh-copilot')"
      warn=$((warn + 1))
    fi
  fi
else
  echo "  ✗ GitHub CLI: not authenticated"
  echo "    Fix: export GH_TOKEN on your host before opening the container,"
  echo "         or run 'gh auth login' inside the container."
  warn=$((warn + 1))
fi

# ── Claude CLI ───────────────────────────────────────────────────
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ✓ Claude CLI: ANTHROPIC_API_KEY is set"
  ok=$((ok + 1))
else
  echo "  ✗ Claude CLI: ANTHROPIC_API_KEY is not set"
  echo "    Fix: export ANTHROPIC_API_KEY on your host before opening the container,"
  echo "         or run 'claude login' inside the container."
  warn=$((warn + 1))
fi

# ── Git identity ─────────────────────────────────────────────────
git_name="$(git config user.name 2>/dev/null || true)"
git_email="$(git config user.email 2>/dev/null || true)"
if [ -n "$git_name" ] && [ -n "$git_email" ]; then
  echo "  ✓ Git identity: $git_name <$git_email>"
  ok=$((ok + 1))
elif gh auth status >/dev/null 2>&1; then
  # Auto-configure from GitHub account.
  api_name="$(gh api user --jq '.name // empty' 2>/dev/null || true)"
  api_email="$(gh api user --jq '.email // empty' 2>/dev/null || true)"
  if [ -n "$api_name" ]; then
    git config --global user.name "$api_name"
    echo "  ✓ Git user.name auto-set from GitHub: $api_name"
  fi
  if [ -n "$api_email" ]; then
    git config --global user.email "$api_email"
    echo "  ✓ Git user.email auto-set from GitHub: $api_email"
  fi
  # Both name and email are required for commits to work.
  final_name="$(git config user.name 2>/dev/null || true)"
  final_email="$(git config user.email 2>/dev/null || true)"
  if [ -n "$final_name" ] && [ -n "$final_email" ]; then
    ok=$((ok + 1))
  else
    [ -z "$final_name" ] && echo "  ✗ Git user.name: still missing"
    [ -z "$final_email" ] && echo "  ✗ Git user.email: still missing (GitHub profile may have private email)"
    echo "    Fix: git config --global user.name 'Your Name'"
    echo "         git config --global user.email 'you@example.com'"
    warn=$((warn + 1))
  fi
else
  echo "  ✗ Git identity: not configured"
  echo "    Fix: git config --global user.name 'Your Name'"
  echo "         git config --global user.email 'you@example.com'"
  warn=$((warn + 1))
fi

# ── SSH agent ────────────────────────────────────────────────────
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  key_count="$(ssh-add -l 2>/dev/null | grep -c . || true)"
  if [ "$key_count" -gt 0 ]; then
    echo "  ✓ SSH agent: $key_count key(s) forwarded from host"
    ok=$((ok + 1))
  else
    echo "  ✗ SSH agent: forwarded but no keys loaded"
    echo "    Fix: run 'ssh-add' on your host before opening the container."
    warn=$((warn + 1))
  fi
else
  echo "  ✗ SSH agent: not forwarded"
  echo "    Note: VS Code forwards the SSH agent automatically."
  echo "          If using a different client, ensure ssh-agent is running."
  warn=$((warn + 1))
fi

echo ""
if [ "$warn" -eq 0 ]; then
  echo "==> All $ok checks passed. Ready to develop!"
else
  echo "==> $ok passed, $warn need attention (see above)."
  echo "    You can still develop — fix auth items when needed."
fi
