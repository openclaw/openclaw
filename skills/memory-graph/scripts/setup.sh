#!/usr/bin/env bash
# memory-graph setup — wires operational changes that make the graph actually useful.
# Run once after installing the skill. Idempotent (safe to re-run).
#
# What this does:
# 1. Creates the graph DB if it doesn't exist
# 2. Patches OpenClaw config to use graph backend
# 3. Adds memory curation cron (nightly)
# 4. Adds a "use graph" reminder to AGENTS.md if not already present
# 5. Patches heartbeat prompt to include graph lookups
#
# Prerequisites:
# - sqlite3 on PATH
# - Python 3.9+ with sqlite3 module
# - OpenClaw running (for config.patch and cron)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="${MEMGRAPH_WORKSPACE:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
DB_DIR="${WORKSPACE}/memory/graph"
DB_PATH="${DB_DIR}/tommy_memory.db"
SCHEMA_PATH="${SCRIPT_DIR}/schema.sql"

echo "memory-graph setup"
echo "  workspace: ${WORKSPACE}"
echo "  db: ${DB_PATH}"
echo ""

# --- 1. Create DB ---
if [ ! -f "$DB_PATH" ]; then
  mkdir -p "$DB_DIR"
  sqlite3 "$DB_PATH" < "$SCHEMA_PATH"
  echo "✅ Created graph database"
else
  echo "⏭️  Database already exists"
fi

# --- 2. Verify schema ---
NODE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM nodes;" 2>/dev/null || echo "FAIL")
if [ "$NODE_COUNT" = "FAIL" ]; then
  echo "❌ Database exists but schema is wrong. Delete and re-run, or apply schema manually."
  exit 1
fi
echo "✅ Schema verified (${NODE_COUNT} nodes)"

# --- 3. Migrate from MEMORY.md if DB is empty and MEMORY.md exists ---
if [ "$NODE_COUNT" = "0" ] && [ -f "${WORKSPACE}/MEMORY.md" ]; then
  echo "📥 Found MEMORY.md with empty DB — running migration..."
  MEMGRAPH_DB="$DB_PATH" MEMGRAPH_MEMORY_MD="${WORKSPACE}/MEMORY.md" \
    python3 "${SCRIPT_DIR}/migrate_from_md.py"
  NEW_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM nodes;")
  echo "✅ Migrated ${NEW_COUNT} nodes from MEMORY.md"
fi

echo ""
echo "Done. Remaining steps (run from your OpenClaw session):"
echo ""
echo "  1. Switch memory backend:"
echo "     gateway config.patch with path='memory' and raw='{\"backend\":\"graph\"}'"
echo ""
echo "  2. Add nightly curation cron (see SKILL.md § Operational Wiring)"
echo ""
echo "  3. Add memory habits to AGENTS.md (see SKILL.md § Agent Habits)"
echo ""
echo "These require OpenClaw tool access and can't be done from a shell script."
