#!/bin/bash
# Shared Memory System Installation Script v2.0
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
cd "$WORKSPACE"

echo "🦞 Setting up Shared Memory System v2.0..."

# Backup existing MEMORY.md
if [ -f "MEMORY.md" ]; then
    cp MEMORY.md "MEMORY.md.backup.$(date +%Y%m%d_%H%M%S)"
    echo "✅ Backed up existing MEMORY.md"
fi

# Create MEMORY.md template
if [ ! -f "MEMORY.md" ]; then
    cat > MEMORY.md << 'EOF'
# MEMORY.md - Long-Term Memory (Agent Name 👾)

## Core Facts & Preferences
- **Human**: Your Name (Timezone: Your/Timezone)
- **Communication**: Primary channel
- **Time Format**: 24-hour
- **Default Model**: gemini-3-flash

## Active Projects
- **Project Name**: Description (Status: IN_PROGRESS)

## Important Rules
- Do NOT self-judge "important" - ask user first
EOF
    echo "✅ Created MEMORY.md"
else
    echo "✅ MEMORY.md already exists"
fi

# Create directories
mkdir -p memory scripts

# Copy sync script
if [ -f "skills/public/shared-memory/scripts/session-memory-sync.py" ]; then
    cp skills/public/shared-memory/scripts/session-memory-sync.py scripts/
    chmod +x scripts/session-memory-sync.py
    echo "✅ Installed sync script"
else
    echo "❌ session-memory-sync.py not found"
    exit 1
fi

# Install config
CONFIG_DIR="$HOME/.openclaw"
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/memory-sync.conf" ]; then
    if [ -f "skills/public/shared-memory/config/memory-sync.conf.example" ]; then
        cp skills/public/shared-memory/config/memory-sync.conf.example "$CONFIG_DIR/memory-sync.conf"
        echo "✅ Created config"
    fi
else
    echo "✅ Config exists"
fi

# Update SOUL.md
if [ -f "SOUL.md" ] && ! grep -q "Session Initialization" "SOUL.md" 2>/dev/null; then
    echo "📝 Add Session Initialization to SOUL.md? (y/n)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        cat >> "SOUL.md" << 'EOF'

## Session Initialization

1. Read MEMORY.md for core facts
2. Read daily notes (last 2 days)
3. Run: python3 scripts/session-memory-sync.py
4. **Silent loading** - don't announce sync
EOF
        echo "✅ Updated SOUL.md"
    fi
else
    echo "✅ SOUL.md ready"
fi

echo ""
echo "🎉 Installation complete!"
echo "Test: python3 scripts/session-memory-sync.py"
