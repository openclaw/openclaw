#!/usr/bin/env bash
# user-setup.sh — runs as the 'vagrant' user (unprivileged)
set -euo pipefail

echo "══════════════════════════════════════════════════"
echo "  OpenClaw VM — User Setup"
echo "══════════════════════════════════════════════════"

# ── 1. Install OpenClaw globally for this user ──────────────
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_CONFIG_PREFIX"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

# Persist PATH for future sessions
grep -q 'npm-global' "$HOME/.bashrc" 2>/dev/null || {
  echo 'export NPM_CONFIG_PREFIX="$HOME/.npm-global"' >> "$HOME/.bashrc"
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"'     >> "$HOME/.bashrc"
}

if ! command -v openclaw &>/dev/null; then
  echo "→ Installing OpenClaw..."
  # The installer's post-install setup wizard reads /dev/tty for interactive
  # input, which doesn't exist during Vagrant provisioning. We let the wizard
  # fail gracefully here — config is handled by `openclaw onboard` after SSH.
  curl -fsSL https://openclaw.ai/install.sh | bash - || {
    echo "→ Interactive setup skipped (expected in non-interactive provisioning)"
  }
else
  echo "→ OpenClaw already installed, skipping."
fi

echo "→ OpenClaw version: $(openclaw --version)"

# ── 2. Set up workspace directory structure ─────────────────
WORKSPACE="$HOME/.openclaw/workspace"
mkdir -p "$WORKSPACE"
mkdir -p "$HOME/.openclaw/credentials"
chmod 700 "$HOME/.openclaw/credentials"

# ── 3. Create minimal workspace files ─────────────────────────
cat > "$WORKSPACE/IDENTITY.md" << 'IDENTITY'
# Identity

You are a helpful AI assistant running inside an isolated OpenClaw VM.
IDENTITY

cat > "$WORKSPACE/USER.md" << 'USER'
# User

Name: Dave
Preferences: Concise answers, technical depth when needed.
USER

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓ Setup complete!"
echo ""
echo "  To configure OpenClaw:"
echo "    openclaw-vm ssh"
echo "    openclaw onboard"
echo ""
echo "  Then start the gateway:"
echo "    openclaw gateway"
echo ""
echo "  WebChat:  http://localhost:18789"
echo "  CLI:      openclaw tui"
echo "  Status:   openclaw status"
echo ""
echo "══════════════════════════════════════════════════"
