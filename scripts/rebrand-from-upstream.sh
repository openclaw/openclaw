#!/usr/bin/env bash
# EVOX.sh Rebrand Script
# Run after merging from upstream openclaw/openclaw
# Usage: ./scripts/rebrand-from-upstream.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$REPO_ROOT"

echo "🔄 EVOX.sh Rebrand Script"
echo "========================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Rename entry point if needed
if [ -f "openclaw.mjs" ] && [ ! -f "evox.mjs" ]; then
  echo -e "${YELLOW}Renaming openclaw.mjs → evox.mjs${NC}"
  mv openclaw.mjs evox.mjs
fi

# Step 2: Core files - full replacement
echo -e "${GREEN}Rebranding core files...${NC}"

# package.json
perl -pi -e 's/"name":\s*"openclaw"/"name": "evox"/g' package.json
perl -pi -e 's#github\.com/openclaw/openclaw#github.com/sonpiaz/evox-sh#g' package.json
perl -pi -e 's/"openclaw":\s*"openclaw\.mjs"/"evox": "evox.mjs"/g' package.json

# Dockerfile
perl -pi -e 's/openclaw\.mjs/evox.mjs/g' Dockerfile
perl -pi -e 's#/usr/local/bin/openclaw#/usr/local/bin/evox#g' Dockerfile

# Step 3: User-facing strings (careful not to break imports)
echo -e "${GREEN}Rebranding user-facing strings...${NC}"

# README.md
perl -pi -e 's/OpenClaw(?![A-Za-z])/EVOX.sh/g' README.md
perl -pi -e 's/openclaw\.ai/evox.sh/g' README.md
perl -pi -e 's/docs\.openclaw\.ai/docs.evox.sh/g' README.md
perl -pi -e 's#github\.com/openclaw/openclaw#github.com/sonpiaz/evox-sh#g' README.md

# Docs (excluding zh-CN generated files and security-owned paths)
find docs -type f \( -name "*.md" -o -name "*.mdx" \) \
  -not -path "docs/zh-CN/*" \
  -not -path "docs/security/*" \
  -print0 | xargs -0 perl -pi -e '
    s/OpenClaw(?![A-Za-z])/EVOX.sh/g;
    s/openclaw\.ai/evox.sh/g;
    s/docs\.openclaw\.ai/docs.evox.sh/g;
    s#github\.com/openclaw/openclaw#github.com/sonpiaz/evox-sh#g;
  '

# Source files - only string literals, preserve imports
echo -e "${GREEN}Rebranding source files (string literals only)...${NC}"

find src -type f -name "*.ts" \
  -not -path "src/security/*" \
  -print0 | xargs -0 perl -pi -e '
    s/OpenClaw(?![A-Za-z])/EVOX.sh/g;
    s/openclaw\.ai/evox.sh/g;
    s/docs\.openclaw\.ai/docs.evox.sh/g;
    s#github\.com/openclaw/openclaw#github.com/sonpiaz/evox-sh#g;
  '

# Step 4: Fix any broken identifiers (EVOX.sh in code → evox)
echo -e "${GREEN}Fixing identifier patterns...${NC}"

# Variables like managedByEVOX.sh → managedByEvox
find src -type f -name "*.ts" -print0 | xargs -0 perl -pi -e '
  s/managedByEVOX\.sh/managedByEvox/g;
  s/hostTmpOutsideEVOX\.sh/hostTmpOutsideEvox/g;
  s/globalThis\.EVOX\.sh/globalThis.evox/g;
'

# Step 5: Preserve backward compatibility
echo -e "${GREEN}Ensuring backward compatibility...${NC}"

# Add openclaw bin alias if missing
if ! grep -q '"openclaw":' package.json; then
  # Add openclaw alias to bin
  perl -pi -e 's/"evox":\s*"evox\.mjs"/"evox": "evox.mjs",\n    "openclaw": "evox.mjs"/g' package.json
fi

# Dockerfile: ensure both symlinks exist
if ! grep -q '/usr/local/bin/openclaw' Dockerfile; then
  perl -pi -e 's#(ln -sf /app/evox\.mjs /usr/local/bin/evox)#$1 \\\n \&\& ln -sf /app/evox.mjs /usr/local/bin/openclaw#g' Dockerfile
fi

# Step 6: Verify
echo ""
echo -e "${GREEN}Verification:${NC}"
echo "Entry point: $(ls evox.mjs 2>/dev/null && echo '✅ evox.mjs exists' || echo '❌ Missing')"
echo "Package name: $(grep -o '"name": "[^"]*"' package.json | head -1)"

# Count remaining openclaw references (excluding allowed patterns)
REMAINING=$(grep -r "openclaw" --include="*.ts" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=dist \
  . 2>/dev/null | \
  grep -v "openclaw/plugin-sdk" | \
  grep -v "@openclaw/" | \
  grep -v "openclaw.plugin.json" | \
  grep -v "openclaw.json" | \
  grep -v ".openclaw" | \
  wc -l | tr -d ' ')

if [ "$REMAINING" -gt 0 ]; then
  echo -e "${YELLOW}⚠️  $REMAINING remaining 'openclaw' references (review manually)${NC}"
else
  echo -e "${GREEN}✅ No unexpected 'openclaw' references${NC}"
fi

echo ""
echo -e "${GREEN}Done! Next steps:${NC}"
echo "1. Review changes: git diff"
echo "2. Build: pnpm build"
echo "3. Test: pnpm test"
echo "4. Docker: docker build -t evox:local ."
