#!/usr/bin/env bash
# install-msf.sh
# Install Metasploit Framework on bodhi1 for bodhi-msf skill.
# Run once as bodhi user (sudo privileges required).
# Usage: bash ~/openbodhi/docs/bodhi/scripts/install-msf.sh

set -euo pipefail

echo "=== Metasploit Framework Install for bodhi1 ==="

# 1. Install metasploit-framework via apt (Kali/Ubuntu repos)
if ! command -v msfconsole &>/dev/null; then
    echo "[1/4] Adding Metasploit repository..."
    curl -fsSL https://apt.metasploit.com/metasploit-framework.gpg.key \
        | sudo gpg --dearmor -o /usr/share/keyrings/metasploit-framework.gpg
    echo "deb [signed-by=/usr/share/keyrings/metasploit-framework.gpg] https://apt.metasploit.com/ buster main" \
        | sudo tee /etc/apt/sources.list.d/metasploit-framework.list
    sudo apt-get update -qq
    sudo apt-get install -y metasploit-framework
    echo "[1/4] Installed."
else
    echo "[1/4] msfconsole already installed: $(msfconsole --version 2>/dev/null | head -1)"
fi

# 2. Initialize the Metasploit database
echo "[2/4] Initializing msfdb..."
sudo msfdb init || echo "  (msfdb init returned non-zero — may already be initialized)"

# 3. Verify database connection
echo "[3/4] Testing db_status..."
msfconsole -q -x "db_status; exit" 2>/dev/null | grep -i 'connected\|postgresql\|not connected' || true

# 4. Create audit log path
echo "[4/4] Ensuring audit log path exists..."
touch ~/.openclaw/msf-audit.jsonl
chmod 600 ~/.openclaw/msf-audit.jsonl

echo ""
echo "=== Done ==="
echo "Test with: msfconsole -q -x 'version; exit'"
echo "In Telegram: /msf status"
