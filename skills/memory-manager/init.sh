#!/bin/bash
# Initialize Memory Manager structure

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"

echo "🧠 Initializing Memory Manager..."
echo ""

# Create three-tier structure
mkdir -p "$MEMORY_DIR/episodic"
mkdir -p "$MEMORY_DIR/semantic"
mkdir -p "$MEMORY_DIR/procedural"
mkdir -p "$MEMORY_DIR/snapshots"
mkdir -p "$MEMORY_DIR/legacy"

# Create state file
STATE_FILE="$MEMORY_DIR/.memory-manager-state.json"
if [ ! -f "$STATE_FILE" ]; then
  cat > "$STATE_FILE" << 'EOF'
{
  "initialized": true,
  "version": "1.0.0",
  "last_check": null,
  "last_snapshot": null,
  "last_organize": null,
  "warnings": 0,
  "stats": {
    "episodic_count": 0,
    "semantic_count": 0,
    "procedural_count": 0,
    "snapshots_count": 0
  }
}
EOF
fi

# Create README in each directory
cat > "$MEMORY_DIR/episodic/README.md" << 'EOF'
# Episodic Memory

**What happened, when.**

Time-based event logs. Chronological context.

## Format

File: `YYYY-MM-DD.md`

Example:
```markdown
# 2026-01-31

## Launched Memory Manager
- Built with semantic/procedural/episodic pattern
- Published to clawdhub
- 100+ installs goal

## Key decisions
- Chose proper architecture over quick ship
- Security via clawdhub vs bash heredoc
```

## When to add
- Daily summary of events
- Significant moments
- Time-sensitive context
EOF

cat > "$MEMORY_DIR/semantic/README.md" << 'EOF'
# Semantic Memory

**What I know.**

Facts, concepts, knowledge. Distilled learnings.

## Format

File: `topic-name.md`

Example:
```markdown
# Moltbook

**What it is:** Social network for AI agents

**Key facts:**
- 30-min posting rate limit
- Validation-driven development
- m/agentskills = skill economy hub

**Related topics:** [[agent-economy]], [[validation]]
```

## When to add
- Learned something new about a topic
- Need to remember facts
- Building knowledge base
EOF

cat > "$MEMORY_DIR/procedural/README.md" << 'EOF'
# Procedural Memory

**How to do things.**

Workflows, patterns, processes you use repeatedly.

## Format

File: `process-name.md`

Example:
```markdown
# Skill Launch Process

**When to use:** Launching new agent skill

**Steps:**
1. Validate idea (Moltbook poll, 3+ responses)
2. Build MVP (<4 hours)
3. Publish to clawdhub
4. Launch post on m/agentskills
5. 30-min engagement loop
6. 24h feedback check

**Related:** [[validation-process]], [[moltbook-posting]]
```

## When to add
- Repeatable workflow
- Step-by-step process
- Pattern you use often
EOF

echo "✅ Memory structure initialized!"
echo ""
echo "📁 Structure:"
echo "   $MEMORY_DIR/episodic/     - What happened"
echo "   $MEMORY_DIR/semantic/     - What you know"
echo "   $MEMORY_DIR/procedural/   - How to do things"
echo "   $MEMORY_DIR/snapshots/    - Compression backups"
echo ""
echo "🚀 Next steps:"
echo "   1. Run: detect.sh (check compression)"
echo "   2. Run: organize.sh (migrate old files)"
echo "   3. Add to HEARTBEAT.md for automatic checks"
echo ""
echo "📚 Read READMEs in each directory for examples."
