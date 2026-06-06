#!/bin/bash
# Jarvis Rebranding Script - Automated Search & Replace
# This script safely rebrand OpenClaw to Jarvis while preserving tool functionality

set -e

echo "🚀 Starting Jarvis Rebranding Process..."

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
TOTAL_FILES=0
MODIFIED_FILES=0

# Function to safely replace in files
safe_replace() {
    local pattern=$1
    local replacement=$2
    local file_pattern=$3
    
    echo -e "${YELLOW}Replacing: $pattern → $replacement in $file_pattern${NC}"
    
    # Find files and perform replacement
    find . -type f -name "$file_pattern" ! -path './node_modules/*' ! -path './.git/*' ! -path './dist/*' | while read file; do
        if grep -q "$pattern" "$file" 2>/dev/null; then
            sed -i.bak "s/$pattern/$replacement/g" "$file"
            rm -f "${file}.bak"
            MODIFIED_FILES=$((MODIFIED_FILES + 1))
            echo -e "${GREEN}✓ Modified: $file${NC}"
        fi
    done
}

# Phase 1: Package and CLI Rebranding
echo -e "\n${YELLOW}Phase 1: Package & CLI Rebranding${NC}"

# Main package names
safe_replace "@openclaw" "@jarvis" "package.json"
safe_replace "openclaw" "jarvis" "package.json"

# Config files
safe_replace "openclaw" "jarvis" "*.mjs"
safe_replace "openclaw" "jarvis" "*.ts"
safe_replace "openclaw" "jarvis" "*.js"

# Documentation
safe_replace "OpenClaw" "Jarvis" "README.md"
safe_replace "openclaw" "jarvis" "README.md"
safe_replace "🦞" "🤖" "README.md"

# Paths and directories
safe_replace "\.openclaw" ".jarvis" "*.mjs"
safe_replace "\.openclaw" ".jarvis" "*.ts"
safe_replace "openclaw\.json" "jarvis.json" "*.mjs"
safe_replace "openclaw\.json" "jarvis.json" "*.ts"

# Extension configs
safe_replace "@openclaw" "@jarvis" "extensions/*/package.json"

# Phase 2: CLI Entry Points
echo -e "\n${YELLOW}Phase 2: CLI Entry Points${NC}"

safe_replace "openclaw" "jarvis" "openclaw.mjs"
safe_replace "OpenClaw" "Jarvis" "openclaw.mjs"

# Phase 3: Config and Constants
echo -e "\n${YELLOW}Phase 3: Configuration Updates${NC}"

safe_replace "openclaw" "jarvis" "tsconfig*.json"
safe_replace "\.openclaw" ".jarvis" ".env.example"

# Phase 4: Documentation
echo -e "\n${YELLOW}Phase 4: Documentation Updates${NC}"

safe_replace "OpenClaw" "Jarvis" "AGENTS.md"
safe_replace "openclaw" "jarvis" "AGENTS.md"

safe_replace "OpenClaw" "Jarvis" "CONTRIBUTING.md"
safe_replace "openclaw" "jarvis" "CONTRIBUTING.md"

echo -e "\n${GREEN}✅ Rebranding Phase Complete!${NC}"
echo -e "Modified $MODIFIED_FILES files"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT - Manual Steps Required:${NC}"
echo "1. Review all changes for accuracy"
echo "2. Test that all tools still work"
echo "3. Update any remaining hardcoded references"
echo "4. Run: git diff to verify changes"
echo ""
