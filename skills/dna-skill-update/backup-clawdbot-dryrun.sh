#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}🔍 Clawdbot Backup Dry Run${NC}"
echo -e "${CYAN}===========================${NC}"
echo ""
echo -e "${YELLOW}This is a DRY RUN - no files will be created or modified${NC}"
echo ""

# Config check
if [ ! -f ~/.clawdbot/clawdbot.json ]; then
  echo -e "${RED}❌ Config file not found: ~/.clawdbot/clawdbot.json${NC}"
  exit 1
fi

# What backup directory would be created
BACKUP_DIR=~/.clawdbot-backups/pre-update-$(date +%Y%m%d-%H%M%S)
echo -e "${BLUE}📁 Would create backup at:${NC}"
echo "   $BACKUP_DIR"
echo ""

# Config analysis
echo -e "${YELLOW}📋 Configuration Analysis${NC}"
CONFIG_SIZE=$(du -h ~/.clawdbot/clawdbot.json | cut -f1)
echo -e "${GREEN}✓${NC} Config file: ~/.clawdbot/clawdbot.json ($CONFIG_SIZE)"

BACKUP_COUNT=$(find ~/.clawdbot -maxdepth 1 -name "*.backup*" -o -name "*.json.*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✓${NC} Found $BACKUP_COUNT additional backup files"
fi

# Sessions check
echo ""
echo -e "${YELLOW}💾 Sessions Analysis${NC}"
if [ -d ~/.clawdbot/sessions ]; then
  SESSION_COUNT=$(find ~/.clawdbot/sessions -type f -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  SESSION_SIZE=$(du -sh ~/.clawdbot/sessions 2>/dev/null | cut -f1)
  echo -e "${GREEN}✓${NC} Sessions directory exists"
  echo "   Files: $SESSION_COUNT session files"
  echo "   Size: $SESSION_SIZE"
  echo -e "${CYAN}→${NC} Would create: sessions.tar.gz"
else
  echo -e "${BLUE}ℹ${NC}  No sessions directory (would skip)"
fi

# Agents check
echo ""
echo -e "${YELLOW}🤖 Agents Analysis${NC}"
if [ -d ~/.clawdbot/agents ]; then
  AGENT_DIRS=$(find ~/.clawdbot/agents -maxdepth 1 -type d | tail -n +2 | wc -l | tr -d ' ')
  AGENT_SIZE=$(du -sh ~/.clawdbot/agents 2>/dev/null | cut -f1)
  echo -e "${GREEN}✓${NC} Agents directory exists"
  echo "   Agents: $AGENT_DIRS"
  echo "   Size: $AGENT_SIZE"
  echo -e "${CYAN}→${NC} Would create: agents.tar.gz"
  
  # List agent directories
  for agent_dir in ~/.clawdbot/agents/*/; do
    if [ -d "$agent_dir" ]; then
      agent_name=$(basename "$agent_dir")
      agent_size=$(du -sh "$agent_dir" 2>/dev/null | cut -f1)
      echo "   - $agent_name ($agent_size)"
    fi
  done
else
  echo -e "${BLUE}ℹ${NC}  No agents directory (would skip)"
fi

# Credentials check
echo ""
echo -e "${YELLOW}🔐 Credentials Analysis${NC}"
if [ -d ~/.clawdbot/credentials ]; then
  CRED_COUNT=$(find ~/.clawdbot/credentials -type f 2>/dev/null | wc -l | tr -d ' ')
  CRED_SIZE=$(du -sh ~/.clawdbot/credentials 2>/dev/null | cut -f1)
  echo -e "${GREEN}✓${NC} Credentials directory exists"
  echo "   Files: $CRED_COUNT credential files"
  echo "   Size: $CRED_SIZE"
  echo -e "${CYAN}→${NC} Would create: credentials.tar.gz"
else
  echo -e "${RED}⚠${NC}  No credentials directory!"
  echo -e "${CYAN}→${NC} Would skip credentials backup"
fi

# Cron check
echo ""
echo -e "${YELLOW}⏰ Cron Analysis${NC}"
if [ -d ~/.clawdbot/cron ]; then
  CRON_COUNT=$(find ~/.clawdbot/cron -type f 2>/dev/null | wc -l | tr -d ' ')
  CRON_SIZE=$(du -sh ~/.clawdbot/cron 2>/dev/null | cut -f1)
  echo -e "${GREEN}✓${NC} Cron directory exists"
  echo "   Jobs: $CRON_COUNT cron files"
  echo "   Size: $CRON_SIZE"
  echo -e "${CYAN}→${NC} Would create: cron.tar.gz"
else
  echo -e "${BLUE}ℹ${NC}  No cron directory (would skip)"
fi

# Sandboxes check
echo ""
echo -e "${YELLOW}📦 Sandboxes Analysis${NC}"
if [ -d ~/.clawdbot/sandboxes ]; then
  SANDBOX_COUNT=$(find ~/.clawdbot/sandboxes -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
  SANDBOX_SIZE=$(du -sh ~/.clawdbot/sandboxes 2>/dev/null | cut -f1)
  echo -e "${GREEN}✓${NC} Sandboxes directory exists"
  echo "   Sandboxes: $SANDBOX_COUNT"
  echo "   Size: $SANDBOX_SIZE"
  echo -e "${CYAN}→${NC} Would create: sandboxes.tar.gz"
else
  echo -e "${BLUE}ℹ${NC}  No sandboxes directory (would skip)"
fi

# Workspaces analysis (DYNAMIC!)
echo ""
echo -e "${YELLOW}🏠 Workspaces Analysis (Dynamic Detection)${NC}"

# Read workspaces from config
WORKSPACE_DATA=$(jq -r '.routing.agents // {} | to_entries[] | "\(.key)|\(.value.workspace // "none")|\(.value.name // .key)"' ~/.clawdbot/clawdbot.json)

if [ -z "$WORKSPACE_DATA" ]; then
  echo -e "${BLUE}ℹ${NC}  No agents configured in routing.agents"
else
  WORKSPACE_COUNT=0
  TOTAL_SIZE=0
  
  echo -e "${BLUE}Detected workspaces from config:${NC}"
  echo ""
  
  while IFS='|' read -r agent_id workspace agent_name; do
    echo -e "  ${CYAN}Agent:${NC} $agent_id"
    echo -e "  ${CYAN}Name:${NC}  $agent_name"
    echo -e "  ${CYAN}Path:${NC}  $workspace"
    
    if [ "$workspace" = "none" ]; then
      echo -e "  ${YELLOW}Status:${NC} No workspace configured"
      echo -e "  ${CYAN}→${NC} Would skip"
    elif [ ! -d "$workspace" ]; then
      echo -e "  ${RED}Status:${NC} Directory not found!"
      echo -e "  ${CYAN}→${NC} Would skip with warning"
    else
      SIZE=$(du -sh "$workspace" 2>/dev/null | cut -f1)
      FILE_COUNT=$(find "$workspace" -type f 2>/dev/null | wc -l | tr -d ' ')
      
      echo -e "  ${GREEN}Status:${NC} Ready to backup"
      echo -e "  ${CYAN}Size:${NC}   $SIZE"
      echo -e "  ${CYAN}Files:${NC}  $FILE_COUNT"
      
      SAFE_NAME=$(echo "$agent_id" | tr '/' '_' | tr ' ' '-')
      echo -e "  ${CYAN}→${NC} Would create: workspace-${SAFE_NAME}.tar.gz"
      
      WORKSPACE_COUNT=$((WORKSPACE_COUNT+1))
    fi
    echo ""
  done <<< "$WORKSPACE_DATA"
  
  echo -e "${GREEN}✓${NC} Would backup $WORKSPACE_COUNT workspace(s)"
fi

# Git state check
echo ""
echo -e "${YELLOW}🔧 Git Repository Analysis${NC}"
if [ -d ~/code/clawdbot/.git ]; then
  cd ~/code/clawdbot
  CURRENT_COMMIT=$(git log -1 --oneline)
  CURRENT_BRANCH=$(git branch --show-current)
  UNCOMMITTED=$(git status --short | wc -l | tr -d ' ')
  
  echo -e "${GREEN}✓${NC} Git repository found"
  echo "   Branch: $CURRENT_BRANCH"
  echo "   Commit: $CURRENT_COMMIT"
  echo "   Uncommitted changes: $UNCOMMITTED"
  echo -e "${CYAN}→${NC} Would create: git-version.txt, git-status.txt, git-remotes.txt"
else
  echo -e "${YELLOW}⚠${NC}  Git repository not found at ~/code/clawdbot"
  echo -e "${CYAN}→${NC} Would skip git state backup"
fi

# Calculate total size
echo ""
echo -e "${YELLOW}📊 Backup Size Estimation${NC}"

TOTAL_SIZE=0
[ -d ~/.clawdbot/sessions ] && TOTAL_SIZE=$((TOTAL_SIZE + $(du -sk ~/.clawdbot/sessions 2>/dev/null | cut -f1)))
[ -d ~/.clawdbot/agents ] && TOTAL_SIZE=$((TOTAL_SIZE + $(du -sk ~/.clawdbot/agents 2>/dev/null | cut -f1)))
[ -d ~/.clawdbot/credentials ] && TOTAL_SIZE=$((TOTAL_SIZE + $(du -sk ~/.clawdbot/credentials 2>/dev/null | cut -f1)))
[ -d ~/.clawdbot/cron ] && TOTAL_SIZE=$((TOTAL_SIZE + $(du -sk ~/.clawdbot/cron 2>/dev/null | cut -f1)))
[ -d ~/.clawdbot/sandboxes ] && TOTAL_SIZE=$((TOTAL_SIZE + $(du -sk ~/.clawdbot/sandboxes 2>/dev/null | cut -f1)))

# Add workspaces
if [ -n "$WORKSPACE_DATA" ]; then
  while IFS='|' read -r agent_id workspace agent_name; do
    if [ "$workspace" != "none" ] && [ -d "$workspace" ]; then
      WS_SIZE=$(du -sk "$workspace" 2>/dev/null | cut -f1)
      TOTAL_SIZE=$((TOTAL_SIZE + WS_SIZE))
    fi
  done <<< "$WORKSPACE_DATA"
fi

# Convert to human readable
if [ $TOTAL_SIZE -gt 1048576 ]; then
  TOTAL_HUMAN="$(echo "scale=1; $TOTAL_SIZE/1048576" | bc)G"
elif [ $TOTAL_SIZE -gt 1024 ]; then
  TOTAL_HUMAN="$(echo "scale=1; $TOTAL_SIZE/1024" | bc)M"
else
  TOTAL_HUMAN="${TOTAL_SIZE}K"
fi

echo "   Estimated backup size: ~$TOTAL_HUMAN (uncompressed)"
echo "   Compressed size: ~$(echo "scale=1; $TOTAL_SIZE*0.3/1024" | bc)M (estimated 70% compression)"

# Check disk space
echo ""
echo -e "${YELLOW}💿 Disk Space Check${NC}"
BACKUP_PARENT=$(dirname ~/.clawdbot-backups)
DISK_AVAIL=$(df -h "$BACKUP_PARENT" 2>/dev/null | tail -1 | awk '{print $4}')
DISK_USED=$(df -h "$BACKUP_PARENT" 2>/dev/null | tail -1 | awk '{print $5}')

echo "   Available space: $DISK_AVAIL"
echo "   Disk usage: $DISK_USED"

if [ -d ~/.clawdbot-backups ]; then
  EXISTING_BACKUPS=$(find ~/.clawdbot-backups -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
  BACKUPS_SIZE=$(du -sh ~/.clawdbot-backups 2>/dev/null | cut -f1)
  echo "   Existing backups: $EXISTING_BACKUPS ($BACKUPS_SIZE total)"
fi

# Summary
echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${CYAN}📋 Backup Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

FILES_TO_CREATE=0
FILES_TO_SKIP=0

echo -e "${GREEN}Files that would be created:${NC}"
[ -f ~/.clawdbot/clawdbot.json ] && echo "   ✓ clawdbot.json" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/.clawdbot/sessions ] && echo "   ✓ sessions.tar.gz" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/.clawdbot/agents ] && echo "   ✓ agents.tar.gz" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/.clawdbot/credentials ] && echo "   ✓ credentials.tar.gz" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/.clawdbot/cron ] && echo "   ✓ cron.tar.gz" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/.clawdbot/sandboxes ] && echo "   ✓ sandboxes.tar.gz" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))

# Workspace files
if [ -n "$WORKSPACE_DATA" ]; then
  while IFS='|' read -r agent_id workspace agent_name; do
    if [ "$workspace" != "none" ] && [ -d "$workspace" ]; then
      SAFE_NAME=$(echo "$agent_id" | tr '/' '_' | tr ' ' '-')
      echo "   ✓ workspace-${SAFE_NAME}.tar.gz"
      FILES_TO_CREATE=$((FILES_TO_CREATE+1))
    fi
  done <<< "$WORKSPACE_DATA"
fi

[ -d ~/code/clawdbot/.git ] && echo "   ✓ git-version.txt" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/code/clawdbot/.git ] && echo "   ✓ git-status.txt" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
[ -d ~/code/clawdbot/.git ] && echo "   ✓ git-remotes.txt" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))
echo "   ✓ BACKUP_INFO.txt" && FILES_TO_CREATE=$((FILES_TO_CREATE+1))

echo ""
echo -e "${YELLOW}Files that would be skipped:${NC}"
[ ! -d ~/.clawdbot/sessions ] && echo "   ⊘ sessions.tar.gz (no directory)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))
[ ! -d ~/.clawdbot/agents ] && echo "   ⊘ agents.tar.gz (no directory)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))
[ ! -d ~/.clawdbot/credentials ] && echo "   ⊘ credentials.tar.gz (no directory)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))
[ ! -d ~/.clawdbot/cron ] && echo "   ⊘ cron.tar.gz (no directory)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))
[ ! -d ~/.clawdbot/sandboxes ] && echo "   ⊘ sandboxes.tar.gz (no directory)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))
[ ! -d ~/code/clawdbot/.git ] && echo "   ⊘ git-*.txt (no repository)" && FILES_TO_SKIP=$((FILES_TO_SKIP+1))

if [ "$FILES_TO_SKIP" -eq 0 ]; then
  echo "   (none - all sources available)"
fi

echo ""
echo -e "${CYAN}Total:${NC} $FILES_TO_CREATE files would be created, $FILES_TO_SKIP skipped"
echo -e "${CYAN}Location:${NC} $BACKUP_DIR"
echo -e "${CYAN}Estimated size:${NC} ~$TOTAL_HUMAN"

echo ""
echo -e "${GREEN}✨ Dry run complete!${NC}"
echo ""
echo -e "${YELLOW}💡 To perform the actual backup:${NC}"
echo "   ~/.skills/clawdbot-update/backup-clawdbot-full.sh"
echo ""
