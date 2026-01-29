#!/bin/bash

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 Clawdbot Upstream Check${NC}"
echo -e "${BLUE}==========================${NC}"
echo ""

# Check if repo exists
if [ ! -d ~/code/clawdbot/.git ]; then
  echo -e "${RED}❌ Clawdbot repository not found at ~/code/clawdbot${NC}"
  exit 1
fi

cd ~/code/clawdbot

# Current state
echo -e "${YELLOW}📍 Current State${NC}"
CURRENT_BRANCH=$(git branch --show-current)
CURRENT_COMMIT=$(git log -1 --oneline)
echo "Branch: $CURRENT_BRANCH"
echo "Commit: $CURRENT_COMMIT"
echo ""

# Fetch upstream
echo -e "${YELLOW}🌐 Fetching upstream...${NC}"
git fetch origin 2>&1 | grep -v "^From"
echo ""

# Check for updates
echo -e "${YELLOW}📊 Update Status${NC}"
BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

if [ "$BEHIND" = "0" ]; then
  echo -e "${GREEN}✅ Up to date with upstream!${NC}"
  echo ""
  echo "Latest commit:"
  git log origin/main -1 --oneline --decorate
else
  echo -e "${YELLOW}⚠️  Behind upstream by $BEHIND commit(s)${NC}"
  echo ""
  echo -e "${BLUE}New commits:${NC}"
  git log --oneline --decorate HEAD..origin/main | head -20
  
  echo ""
  echo -e "${YELLOW}Changes summary:${NC}"
  git diff --stat HEAD..origin/main | tail -20
fi

echo ""
echo -e "${YELLOW}🏷️  Latest Tags${NC}"
git tag -l | grep "v2026" | tail -5

echo ""
echo -e "${YELLOW}📝 Recent Releases${NC}"
git log --tags --simplify-by-decoration --pretty="format:%ci %d" | head -3

echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"

if [ "$BEHIND" != "0" ]; then
  echo -e "${YELLOW}💡 To update:${NC}"
  echo "  1. Backup: ~/.skills/clawdbot-update/backup-clawdbot-full.sh"
  echo "  2. Update: git pull --rebase origin main"
  echo "  3. Build:  pnpm install && pnpm build"
  echo ""
  echo "Or use the full checklist:"
  echo "  cat ~/.skills/clawdbot-update/UPDATE_CHECKLIST.md"
fi

echo ""
