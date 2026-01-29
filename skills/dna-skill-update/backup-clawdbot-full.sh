#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Clawdbot Full Backup Script${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# Config check
if [ ! -f ~/.clawdbot/clawdbot.json ]; then
  echo -e "${RED}❌ Config file not found: ~/.clawdbot/clawdbot.json${NC}"
  exit 1
fi

# Backup Directory
BACKUP_DIR=~/.clawdbot-backups/pre-update-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
echo -e "${GREEN}📁 Backup Directory: $BACKUP_DIR${NC}"
echo ""

# 1. Config Backup
echo -e "${YELLOW}📋 Backing up configuration...${NC}"
cp ~/.clawdbot/clawdbot.json "$BACKUP_DIR/clawdbot.json"
echo -e "${GREEN}✅ Config backed up${NC}"

# Copy all backup files
cp ~/.clawdbot/*.backup* "$BACKUP_DIR/" 2>/dev/null || true
cp ~/.clawdbot/*.json.* "$BACKUP_DIR/" 2>/dev/null || true

# 2. Sessions
echo ""
echo -e "${YELLOW}💾 Backing up sessions...${NC}"
if [ -d ~/.clawdbot/sessions ]; then
  tar -czf "$BACKUP_DIR/sessions.tar.gz" -C ~/.clawdbot sessions/
  echo -e "${GREEN}✅ Sessions backed up${NC}"
else
  echo -e "${BLUE}ℹ️  No sessions directory${NC}"
fi

# 3. Agents State
echo ""
echo -e "${YELLOW}🤖 Backing up agents...${NC}"
if [ -d ~/.clawdbot/agents ]; then
  tar -czf "$BACKUP_DIR/agents.tar.gz" -C ~/.clawdbot agents/
  echo -e "${GREEN}✅ Agents backed up${NC}"
else
  echo -e "${BLUE}ℹ️  No agents directory${NC}"
fi

# 4. Credentials
echo ""
echo -e "${YELLOW}🔐 Backing up credentials...${NC}"
if [ -d ~/.clawdbot/credentials ]; then
  tar -czf "$BACKUP_DIR/credentials.tar.gz" -C ~/.clawdbot credentials/
  echo -e "${GREEN}✅ Credentials backed up${NC}"
else
  echo -e "${RED}⚠️  No credentials directory!${NC}"
fi

# 5. Cron
echo ""
echo -e "${YELLOW}⏰ Backing up cron jobs...${NC}"
if [ -d ~/.clawdbot/cron ]; then
  tar -czf "$BACKUP_DIR/cron.tar.gz" -C ~/.clawdbot cron/
  echo -e "${GREEN}✅ Cron jobs backed up${NC}"
else
  echo -e "${BLUE}ℹ️  No cron directory${NC}"
fi

# 6. Sandboxes
echo ""
echo -e "${YELLOW}📦 Backing up sandboxes...${NC}"
if [ -d ~/.clawdbot/sandboxes ]; then
  tar -czf "$BACKUP_DIR/sandboxes.tar.gz" -C ~/.clawdbot sandboxes/
  echo -e "${GREEN}✅ Sandboxes backed up${NC}"
else
  echo -e "${BLUE}ℹ️  No sandboxes directory${NC}"
fi

# 7. Workspaces (DYNAMIC!)
echo ""
echo -e "${YELLOW}🏠 Backing up workspaces (reading from config)...${NC}"

# Read workspaces from config
WORKSPACE_DATA=$(jq -r '.routing.agents // {} | to_entries[] | "\(.key)|\(.value.workspace // "none")|\(.value.name // .key)"' ~/.clawdbot/clawdbot.json)

if [ -z "$WORKSPACE_DATA" ]; then
  echo -e "${BLUE}ℹ️  No agents configured${NC}"
else
  WORKSPACE_COUNT=0
  WORKSPACE_SIZES=""
  
  while IFS='|' read -r agent_id workspace agent_name; do
    if [ "$workspace" != "none" ] && [ -d "$workspace" ]; then
      echo -e "  📦 Backing up ${BLUE}$agent_id${NC} ($agent_name)..."
      echo "     Path: $workspace"
      
      # Create safe filename (replace / with _)
      SAFE_NAME=$(echo "$agent_id" | tr '/' '_' | tr ' ' '-')
      tar -czf "$BACKUP_DIR/workspace-${SAFE_NAME}.tar.gz" -C "$workspace" . 2>/dev/null
      
      SIZE=$(du -sh "$workspace" 2>/dev/null | cut -f1)
      echo -e "     ${GREEN}✅ Backed up ($SIZE)${NC}"
      
      WORKSPACE_COUNT=$((WORKSPACE_COUNT+1))
      WORKSPACE_SIZES="${WORKSPACE_SIZES}\n  - $agent_id: $workspace ($SIZE)"
    elif [ "$workspace" = "none" ]; then
      echo -e "  ${YELLOW}⚠️${NC}  Agent '$agent_id' has no workspace configured"
    else
      echo -e "  ${RED}❌${NC} Agent '$agent_id' workspace not found: $workspace"
    fi
  done <<< "$WORKSPACE_DATA"
  
  echo ""
  echo -e "${GREEN}✅ Backed up $WORKSPACE_COUNT workspace(s)${NC}"
fi

# 8. Git State
echo ""
echo -e "${YELLOW}🔧 Backing up git state...${NC}"
if [ -d ~/code/clawdbot/.git ]; then
  cd ~/code/clawdbot
  git log -1 --oneline > "$BACKUP_DIR/git-version.txt"
  git branch --show-current >> "$BACKUP_DIR/git-version.txt"
  git status --short > "$BACKUP_DIR/git-status.txt"
  git remote -v > "$BACKUP_DIR/git-remotes.txt"
  echo -e "${GREEN}✅ Git state saved${NC}"
else
  echo -e "${YELLOW}⚠️  Git repository not found${NC}"
fi

# 9. Backup Info
echo ""
echo -e "${YELLOW}📝 Creating backup info...${NC}"

# Generate workspace list for restore instructions
RESTORE_WORKSPACES=""
if [ -n "$WORKSPACE_DATA" ]; then
  while IFS='|' read -r agent_id workspace agent_name; do
    if [ "$workspace" != "none" ] && [ -d "$workspace" ]; then
      SAFE_NAME=$(echo "$agent_id" | tr '/' '_' | tr ' ' '-')
      RESTORE_WORKSPACES="${RESTORE_WORKSPACES}   tar -xzf \$BACKUP_DIR/workspace-${SAFE_NAME}.tar.gz -C $workspace\n"
    fi
  done <<< "$WORKSPACE_DATA"
fi

cat > "$BACKUP_DIR/BACKUP_INFO.txt" << EOF
Clawdbot Full Backup
====================
Date: $(date)
Backup Location: $BACKUP_DIR

Git Information:
----------------
$(cat "$BACKUP_DIR/git-version.txt" 2>/dev/null || echo "Not available")

Repository: https://github.com/clawdbot/clawdbot

Contents:
---------
$(ls -lh "$BACKUP_DIR" | tail -n +2)

Workspace Information:
---------------------$(echo -e "$WORKSPACE_SIZES")

Agents Configuration:
--------------------
$(jq -r '.routing.agents // {} | to_entries[] | "  - \(.key): \(.value.name // .key)"' ~/.clawdbot/clawdbot.json)

Restore Instructions:
---------------------
1. Stop Gateway:
   cd ~/code/clawdbot
   pnpm clawdbot gateway stop

2. Restore Config:
   cp $BACKUP_DIR/clawdbot.json ~/.clawdbot/clawdbot.json

3. Restore State:
   tar -xzf $BACKUP_DIR/sessions.tar.gz -C ~/.clawdbot 2>/dev/null || true
   tar -xzf $BACKUP_DIR/agents.tar.gz -C ~/.clawdbot 2>/dev/null || true
   tar -xzf $BACKUP_DIR/credentials.tar.gz -C ~/.clawdbot 2>/dev/null || true
   tar -xzf $BACKUP_DIR/cron.tar.gz -C ~/.clawdbot 2>/dev/null || true
   tar -xzf $BACKUP_DIR/sandboxes.tar.gz -C ~/.clawdbot 2>/dev/null || true

4. Restore Workspaces:
$(echo -e "$RESTORE_WORKSPACES")

5. Restore Git (optional):
   cd ~/code/clawdbot
   git checkout <commit from git-version.txt>
   pnpm install
   pnpm build

6. Start Gateway:
   pnpm clawdbot gateway start

Quick Restore:
--------------
Use the restore script:
  ~/.skills/clawdbot-update/restore-clawdbot.sh $BACKUP_DIR
EOF

# 10. Summary
echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${GREEN}✨ Backup Complete!${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}📊 Backup Statistics:${NC}"
echo "Total Size: $(du -sh "$BACKUP_DIR" | cut -f1)"
echo "Location:   $BACKUP_DIR"
echo ""

# Validation
echo -e "${YELLOW}🔍 Validation:${NC}"
[ -f "$BACKUP_DIR/clawdbot.json" ] && echo -e "${GREEN}✅${NC} Config" || echo -e "${RED}❌${NC} Config"
[ -f "$BACKUP_DIR/credentials.tar.gz" ] && echo -e "${GREEN}✅${NC} Credentials" || echo -e "${YELLOW}⚠️${NC} Credentials"

# Count workspace backups
WORKSPACE_BACKUP_COUNT=$(find "$BACKUP_DIR" -name "workspace-*.tar.gz" 2>/dev/null | wc -l | tr -d ' ')
if [ "$WORKSPACE_BACKUP_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅${NC} Workspaces ($WORKSPACE_BACKUP_COUNT backed up)"
  find "$BACKUP_DIR" -name "workspace-*.tar.gz" -exec basename {} \; | sed 's/^/   - /'
else
  echo -e "${YELLOW}⚠️${NC} No workspaces backed up"
fi

echo ""
echo -e "${GREEN}📁 Backup saved to:${NC}"
echo -e "${BLUE}$BACKUP_DIR${NC}"
echo ""
echo -e "${YELLOW}💡 Next steps:${NC}"
echo "1. Review backup: cat $BACKUP_DIR/BACKUP_INFO.txt"
echo "2. Run validation: ~/.skills/clawdbot-update/validate-setup.sh"
echo "3. Proceed with update when ready"
echo ""
