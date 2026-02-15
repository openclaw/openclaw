#!/bin/bash
set -euo pipefail

# ── OpenClaw Agent Bootstrap — GCP ──
# This script runs as VM startup-script on first boot.
# Variables are injected by PlaneManager at provision time.

AGENT_ID="${AGENT_ID:-__AGENT_ID__}"
OWNER_EMAIL="${OWNER_EMAIL:-__OWNER_EMAIL__}"
MODEL_TIER="${MODEL_TIER:-__MODEL_TIER__}"
MODEL="${MODEL:-__MODEL__}"
TOOLS="${TOOLS:-__TOOLS__}"
CHANNELS="${CHANNELS:-__CHANNELS__}"
GCP_PROJECT="${GCP_PROJECT:-__GCP_PROJECT__}"

export DEBIAN_FRONTEND=noninteractive

# 1. System setup
apt-get update -qq
apt-get install -y -qq curl git jq unzip

# 2. Install Node.js 22
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# 3. Install OpenClaw
if ! command -v openclaw &>/dev/null; then
  curl -fsSL https://openclaw.dev/install.sh | bash
fi

# 4. Create agent user
useradd -m -s /bin/bash agent 2>/dev/null || true

# 5. Write agent config
mkdir -p /home/agent/.openclaw/workspace
cat > /home/agent/.openclaw/config.json << AGENT_CONFIG
{
  "agentId": "${AGENT_ID}",
  "owner": "${OWNER_EMAIL}",
  "modelTier": "${MODEL_TIER}",
  "model": "${MODEL}",
  "tools": ${TOOLS},
  "channels": ${CHANNELS},
  "secrets": {
    "provider": "gcp-secret-manager",
    "project": "${GCP_PROJECT}",
    "prefix": "agents/${AGENT_ID}/"
  }
}
AGENT_CONFIG

# 6. Write BOOTSTRAP.md
cat > /home/agent/.openclaw/workspace/BOOTSTRAP.md << 'BOOTSTRAP_MD'
# Welcome

You are a new AI agent. Your owner will be configured shortly.

## First Task
1. Send an introductory email to your owner
2. Explain what you can help with
3. Share links to connect additional channels
4. Delete this file after sending the email
BOOTSTRAP_MD

# 7. Fix ownership
chown -R agent:agent /home/agent/.openclaw

# 8. Start OpenClaw gateway
su - agent -c "openclaw gateway start" &

echo "OpenClaw agent ${AGENT_ID} bootstrap complete"
