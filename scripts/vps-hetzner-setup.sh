#!/usr/bin/env bash
# VPS hardening script for Hetzner (Ubuntu 24.04)
# Creates a dedicated openclaw user, hardens SSH, sets up UFW + swap,
# and enables unattended security updates.
#
# Usage (as root on a fresh Hetzner VPS):
#   curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/vps-hetzner-setup.sh | bash
#
# What this script does:
#   1. Creates "openclaw" user with sudo access
#   2. Copies root SSH keys to the new user
#   3. Hardens sshd (disable root login, disable password auth, limit auth tries)
#   4. Configures UFW (deny all incoming, allow SSH + Tailscale)
#   5. Adds 2GB swap as OOM safety net
#   6. Enables unattended security updates
#   7. Sets hostname to "openclaw"
#
# After running this script:
#   1. Verify SSH as openclaw user:  ssh openclaw@YOUR_VPS_IP
#   2. Install Tailscale:            curl -fsSL https://tailscale.com/install.sh | sh
#   3. Activate Tailscale SSH:       sudo tailscale up --ssh --hostname=openclaw
#   4. Remove public SSH:            sudo ufw delete allow 22/tcp
#
# See: docs/install/hetzner-native.md

set -euo pipefail

# --- Preflight ---

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: This script must be run as root." >&2
  exit 1
fi

if ! grep -qi 'ubuntu' /etc/os-release 2>/dev/null; then
  echo "Warning: This script is designed for Ubuntu. Proceeding anyway..." >&2
fi

USERNAME="${OPENCLAW_VPS_USER:-openclaw}"
SWAP_SIZE="${OPENCLAW_SWAP_SIZE:-2G}"

echo "==> OpenClaw VPS Hardening"
echo "    User:      $USERNAME"
echo "    Swap:      $SWAP_SIZE"
echo ""

# --- 1. Create dedicated user ---

if id "$USERNAME" &>/dev/null; then
  echo "==> User '$USERNAME' already exists, skipping creation"
else
  echo "==> Creating user '$USERNAME'"
  adduser --disabled-password --gecos "" "$USERNAME"
  usermod -aG sudo "$USERNAME"
  echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$USERNAME"
  chmod 440 "/etc/sudoers.d/$USERNAME"
fi

# Copy SSH authorized_keys from root
if [[ -f /root/.ssh/authorized_keys ]]; then
  echo "==> Copying SSH keys to $USERNAME"
  mkdir -p "/home/$USERNAME/.ssh"
  cp /root/.ssh/authorized_keys "/home/$USERNAME/.ssh/"
  chown -R "$USERNAME:$USERNAME" "/home/$USERNAME/.ssh"
  chmod 700 "/home/$USERNAME/.ssh"
  chmod 600 "/home/$USERNAME/.ssh/authorized_keys"
else
  echo "Warning: /root/.ssh/authorized_keys not found. Add SSH keys manually." >&2
fi

# --- 2. Harden SSH ---

echo "==> Hardening SSH"
SSHD_CONFIG="/etc/ssh/sshd_config"

sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' "$SSHD_CONFIG"
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"

systemctl restart sshd

# --- 3. Firewall (UFW) ---

echo "==> Configuring UFW"
apt-get update -qq
apt-get install -y -qq ufw > /dev/null

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH (remove after Tailscale setup)"
ufw allow 41641/udp comment "Tailscale"
ufw --force enable

# --- 4. Swap ---

SWAPFILE="/swapfile"
if [[ -f "$SWAPFILE" ]]; then
  echo "==> Swap file already exists, skipping"
else
  echo "==> Adding ${SWAP_SIZE} swap"
  fallocate -l "$SWAP_SIZE" "$SWAPFILE"
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"

  if ! grep -q "$SWAPFILE" /etc/fstab; then
    echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
  fi
fi

# --- 5. Unattended security updates ---

echo "==> Enabling unattended security updates"
apt-get install -y -qq unattended-upgrades > /dev/null
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51openclaw-no-reboot
dpkg-reconfigure -plow unattended-upgrades

# --- 6. Hostname ---

echo "==> Setting hostname to 'openclaw'"
hostnamectl set-hostname openclaw

# --- 7. Enable lingering ---

echo "==> Enabling linger for $USERNAME"
loginctl enable-linger "$USERNAME"

# --- Done ---

echo ""
echo "==> VPS hardening complete!"
echo ""
echo "Next steps:"
echo "  1. Open a NEW terminal and verify SSH:"
echo "     ssh $USERNAME@YOUR_VPS_IP"
echo ""
echo "  2. Switch to $USERNAME and install Tailscale:"
echo "     su - $USERNAME"
echo "     curl -fsSL https://tailscale.com/install.sh | sh"
echo "     sudo tailscale up --ssh --hostname=openclaw"
echo ""
echo "  3. Verify Tailscale SSH from your laptop:"
echo "     ssh $USERNAME@openclaw"
echo ""
echo "  4. Once Tailscale SSH works, remove public SSH:"
echo "     sudo ufw delete allow 22/tcp"
echo ""
echo "  5. Install OpenClaw:"
echo "     curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
echo "     sudo apt-get install -y nodejs"
echo "     curl -fsSL https://openclaw.ai/install.sh | bash"
echo ""
echo "Full guide: https://docs.openclaw.ai/install/hetzner-native"
