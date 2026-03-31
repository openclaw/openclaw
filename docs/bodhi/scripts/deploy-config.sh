#!/usr/bin/env bash
# deploy-config.sh
# Sync repo openclaw.json to bodhi1, preserving secrets already on the server.
#
# Strategy:
#   1. Copy repo openclaw.json to bodhi1
#   2. Re-inject the live bot token (already set on server) so it survives the sync
#   3. Reload the gateway
#
# Usage (from repo root on your local machine):
#   bash docs/bodhi/scripts/deploy-config.sh
#
# Prerequisites:
#   - SSH access to bodhi1 via Tailscale (run `tailscale up` if disconnected)
#   - openclaw.json committed in this worktree with all schedule/delivery fixes

set -euo pipefail

GOLD='\033[38;2;212;175;55m'
SUCCESS='\033[38;2;80;200;120m'
MUTED='\033[38;2;100;100;120m'
ERROR='\033[38;2;210;60;60m'
BOLD='\033[1m'
NC='\033[0m'

SSH_HOST="${BODHI_SSH_HOST:-bodhi1}"
REPO_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/openclaw.json"
REMOTE_CONFIG="~/.openclaw/openclaw.json"
REMOTE_BACKUP="~/.openclaw/openclaw.json.bak.$(date +%Y%m%dT%H%M%S)"

echo ""
echo -e "${GOLD}${BOLD}  deploy-config${NC}  ${MUTED}→ ${SSH_HOST}${NC}"
echo ""

# ── 1. Verify SSH ──────────────────────────────────────────────────────────────
echo -e "  ${MUTED}[1/4] testing SSH connection...${NC}"
if ! ssh -o ConnectTimeout=8 -o BatchMode=yes "$SSH_HOST" "echo ok" &>/dev/null; then
  echo -e "  ${ERROR}✗ Cannot reach ${SSH_HOST}${NC}"
  echo ""
  echo -e "  ${MUTED}Fix options:${NC}"
  echo -e "  ${MUTED}  • Tailscale down? Run: tailscale up${NC}"
  echo -e "  ${MUTED}  • SSH key issue? Run: ssh-add ~/.ssh/id_ed25519${NC}"
  echo -e "  ${MUTED}  • Custom host: BODHI_SSH_HOST=bodhi@ip bash deploy-config.sh${NC}"
  echo ""
  exit 1
fi
echo -e "  ${SUCCESS}✓ connected${NC}"
echo ""

# ── 2. Backup existing config on server ────────────────────────────────────────
echo -e "  ${MUTED}[2/4] backing up server config...${NC}"
ssh "$SSH_HOST" "cp $REMOTE_CONFIG $REMOTE_BACKUP" 2>/dev/null && \
  echo -e "  ${SUCCESS}✓ backup: ${REMOTE_BACKUP}${NC}" || \
  echo -e "  ${MUTED}  (no existing config to back up)${NC}"
echo ""

# ── 3. Extract live token before overwriting ───────────────────────────────────
echo -e "  ${MUTED}[3/4] preserving live bot token...${NC}"
LIVE_TOKEN="$(ssh "$SSH_HOST" "python3 -c \"
import re, json, os
try:
    raw = open(os.path.expanduser('$REMOTE_CONFIG')).read()
    raw = re.sub(r'//[^\n]*', '', raw)
    raw = re.sub(r',\s*([}\]])', r'\1', raw)
    d = json.loads(raw)
    print(d.get('channels',{}).get('telegram',{}).get('token',''))
except:
    print('')
\"" 2>/dev/null || echo "")"

if [[ -n "$LIVE_TOKEN" ]] && [[ "$LIVE_TOKEN" != "\${TELEGRAM_BOT_TOKEN}" ]]; then
  echo -e "  ${SUCCESS}✓ live token captured${NC}"
else
  echo -e "  ${MUTED}  no live token found — token placeholder will remain${NC}"
  LIVE_TOKEN=""
fi
echo ""

# ── 4. Copy new config ─────────────────────────────────────────────────────────
echo -e "  ${MUTED}[4/4] deploying new config...${NC}"
scp -q "$REPO_CONFIG" "${SSH_HOST}:${REMOTE_CONFIG}"

# Re-inject the live token if we captured one
if [[ -n "$LIVE_TOKEN" ]]; then
  ssh "$SSH_HOST" "python3 - << 'PYEOF'
import re, os

config_path = os.path.expanduser('$REMOTE_CONFIG')
token = '$LIVE_TOKEN'
raw = open(config_path).read()

def replace_token(content, tok):
    tg_start = content.find('\"telegram\"')
    if tg_start == -1:
        return content
    brace_start = content.find('{', tg_start)
    depth, pos = 0, brace_start
    for i, c in enumerate(content[brace_start:], brace_start):
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                pos = i
                break
    block = content[brace_start:pos+1]
    new_block = re.sub(r'(\"token\"\s*:\s*\")[^\"]*\"', f'\"token\": \"{tok}\"', block)
    return content[:brace_start] + new_block + content[pos+1:]

updated = replace_token(raw, token)
tmp = config_path + '.tmp'
open(tmp, 'w').write(updated)
os.replace(tmp, config_path)
print('token reinjected')
PYEOF
"
fi

echo -e "  ${SUCCESS}✓ config deployed${NC}"
echo ""

# ── Reload gateway ─────────────────────────────────────────────────────────────
echo -e "  ${MUTED}Reloading gateway...${NC}"
ssh "$SSH_HOST" "
  if command -v openclaw &>/dev/null; then
    openclaw reload 2>/dev/null && echo 'openclaw reloaded' || true
  fi
  # If openbodhi CLI is installed, it handles the PID file
  if command -v openbodhi &>/dev/null; then
    openbodhi restart
  else
    # Fallback: kill and restart
    pkill -f 'openclaw.*start' 2>/dev/null || true
    sleep 1
    cd ~/openbodhi && nohup node openclaw.mjs start >> ~/.openclaw/gateway.log 2>&1 &
    echo \"gateway restarted (pid \$!)\"
  fi
" 2>&1 || echo -e "  ${MUTED}  gateway restart skipped — restart manually: openbodhi restart${NC}"

echo ""
echo -e "  ${SUCCESS}Deploy complete.${NC}"
echo ""
echo -e "  ${MUTED}Verify: openbodhi status  (run on bodhi1)${NC}"
echo ""
