#!/bin/bash
# Setup OpenClaw Auth Management System
# Run this once to set up:
# 1. Long-lived Claude Code token
# 2. Auth monitoring with notifications
# 3. Instructions for Termux widgets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== OpenClaw Auth System Setup ==="
echo ""

# Step 1: Check current auth status
echo "Step 1: Checking current auth status..."
"$SCRIPT_DIR/claude-auth-status.sh" full || true
echo ""

# Step 2: Set up long-lived token
echo "Step 2: Long-lived token setup"
echo ""
echo "Option A: Use 'claude setup-token' (recommended)"
echo "  - Creates a long-lived API token"
echo "  - No daily re-auth needed"
echo "  - Run: claude setup-token"
echo ""
echo "Would you like to set up a long-lived token now? [y/N]"
read -r SETUP_TOKEN

if [[ "$SETUP_TOKEN" =~ ^[Yy] ]]; then
    echo ""
    echo "Opening https://console.anthropic.com/settings/api-keys"
    echo "Create a new key or copy existing one, then paste below."
    echo ""
    claude setup-token
fi

echo ""

# Step 3: Set up auth monitoring
echo "Step 3: Auth monitoring setup"
echo ""
echo "The auth monitor checks expiry every 30 minutes and notifies you."
echo ""
echo "Configure notification channels:"
echo ""

# Check for ntfy
echo "  ntfy.sh: Free push notifications to your phone"
echo "  1. Install ntfy app on your phone"
echo "  2. Subscribe to a topic (e.g., 'openclaw-alerts')"
echo ""
echo "Enter ntfy.sh topic (or leave blank to skip):"
read -r NTFY_TOPIC

# Phone notification
echo ""
echo "  OpenClaw message: Send warning via OpenClaw itself"
echo "Enter your phone number for alerts (or leave blank to skip):"
read -r PHONE_NUMBER

# Install systemd units
SERVICE_TEMPLATE="$SCRIPT_DIR/systemd/openclaw-auth-monitor.service"
SERVICE_TARGET="$HOME/.config/systemd/user/openclaw-auth-monitor.service"
TIMER_TARGET="$HOME/.config/systemd/user/openclaw-auth-monitor.timer"
AUTH_MONITOR_PATH="$SCRIPT_DIR/auth-monitor.sh"

echo ""
echo "Installing systemd timer..."
mkdir -p ~/.config/systemd/user
cp "$SERVICE_TEMPLATE" "$SERVICE_TARGET"
cp "$SCRIPT_DIR/systemd/openclaw-auth-monitor.timer" "$TIMER_TARGET"

command -v python3 >/dev/null 2>&1 || {
    echo "ERROR: python3 is required but not found."
    exit 1
}

python3 - "$SERVICE_TARGET" "$AUTH_MONITOR_PATH" "$NTFY_TOPIC" "$PHONE_NUMBER" <<'PY'
from pathlib import Path
import sys

service_path = Path(sys.argv[1])
auth_monitor_path = sys.argv[2]
ntfy_topic = sys.argv[3]
phone_number = sys.argv[4]


def systemd_quote_arg(value: str) -> str:
    escaped = value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def replace_required(content: str, old: str, new: str, label: str) -> str:
    updated = content.replace(old, new)
    if updated == content:
        print(f"ERROR: {label} placeholder not found in {service_path}", file=sys.stderr)
        sys.exit(1)
    return updated


content = service_path.read_text()
content = replace_required(
    content,
    "ExecStart=/home/admin/openclaw/scripts/auth-monitor.sh",
    f"ExecStart={systemd_quote_arg(auth_monitor_path)}",
    "ExecStart",
)
if ntfy_topic:
    content = replace_required(
        content,
        "# Environment=NOTIFY_NTFY=openclaw-alerts",
        f"Environment=NOTIFY_NTFY={ntfy_topic}",
        "NOTIFY_NTFY",
    )
if phone_number:
    content = replace_required(
        content,
        "# Environment=NOTIFY_PHONE=+1234567890",
        f"Environment=NOTIFY_PHONE={phone_number}",
        "NOTIFY_PHONE",
    )
service_path.write_text(content)
PY

systemctl --user daemon-reload
systemctl --user enable --now openclaw-auth-monitor.timer

echo "Auth monitor installed and running."
echo ""

# Step 4: Termux widget setup
echo "Step 4: Termux widget setup (for phone)"
echo ""
echo "To set up quick auth from your phone:"
echo ""
echo "1. Install Termux and Termux:Widget from F-Droid"
echo "2. Create ~/.shortcuts/ directory in Termux:"
echo "   mkdir -p ~/.shortcuts"
echo ""
echo "3. Copy the widget scripts:"
echo "   scp $SCRIPT_DIR/termux-quick-auth.sh phone:~/.shortcuts/ClawdAuth"
echo "   scp $SCRIPT_DIR/termux-auth-widget.sh phone:~/.shortcuts/ClawdAuth-Full"
echo ""
echo "4. Make them executable on phone:"
echo "   ssh phone 'chmod +x ~/.shortcuts/Clawd*'"
echo ""
echo "5. Add Termux:Widget to your home screen"
echo "6. Tap the widget to see your auth scripts"
echo ""
echo "The quick widget (ClawdAuth) shows status and opens auth URL if needed."
echo "The full widget (ClawdAuth-Full) provides guided re-auth flow."
echo ""

# Summary
echo "=== Setup Complete ==="
echo ""
echo "What's configured:"
echo "  - Auth status: $SCRIPT_DIR/claude-auth-status.sh"
echo "  - Mobile re-auth: $SCRIPT_DIR/mobile-reauth.sh"
echo "  - Auth monitor: systemctl --user status openclaw-auth-monitor.timer"
echo ""
echo "Quick commands:"
echo "  Check auth:  $SCRIPT_DIR/claude-auth-status.sh"
echo "  Re-auth:     $SCRIPT_DIR/mobile-reauth.sh"
echo "  Test monitor: $SCRIPT_DIR/auth-monitor.sh"
echo ""
