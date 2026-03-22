#!/usr/bin/env bash
# provision.sh — runs as root inside the VM
set -euo pipefail

echo "══════════════════════════════════════════════════"
echo "  OpenClaw VM — System Provisioning"
echo "══════════════════════════════════════════════════"

# ── 1. System packages ──────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git jq build-essential

# ── 2. Node.js 22 via NodeSource ────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "→ Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "→ Node $(node -v)  /  npm $(npm -v)"

# ── 3. Firewall — only allow outbound to needed services ────
# This limits blast radius if a malicious skill tries to phone home.
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow in on lo           # loopback
ufw allow in 18789/tcp       # gateway WebUI (from host via NAT)
ufw allow in 18790/tcp       # bridge
ufw allow ssh                # so 'vagrant ssh' keeps working
ufw --force enable
echo "→ Firewall enabled"

# ── 4. VM config (passed as env vars by Vagrantfile) ──────────
INSTALL_OLLAMA="${INSTALL_OLLAMA:-false}"

# ── 5. Install Ollama (local LLM runtime) — conditional ───────

if [[ "$INSTALL_OLLAMA" == "true" ]]; then
  if ! command -v ollama &>/dev/null; then
    echo "→ Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  echo "→ Ollama $(ollama --version)"

  # Start Ollama service so it's ready for model pulls
  systemctl enable ollama
  systemctl start ollama
else
  echo "→ Skipping Ollama (local models not selected)"
  echo "  Install later with: openclaw onboard"
fi

# ── 6. Create a dedicated openclaw system user ──────────────
if ! id -u openclaw &>/dev/null; then
  useradd -m -s /bin/bash openclaw
fi

# ── 7. SSH password auth (for LAN access) ────────────────────

if [[ -n "${VM_PASSWORD:-}" ]]; then
  echo "→ Enabling SSH password auth..."
  # Set password for the vagrant user
  echo "vagrant:${VM_PASSWORD}" | chpasswd

  # Enable password auth in sshd
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config

  # Harden: disable root login, limit attempts
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config

  systemctl restart sshd
  echo "→ SSH password auth enabled (root login disabled, max 3 attempts)"
else
  echo "→ No VM_PASSWORD set — SSH password auth remains disabled"
fi

echo "→ System provisioning complete."