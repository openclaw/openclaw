#!/usr/bin/env bash
set -euo pipefail

# Build Postgres URL from components so password is correct (Compose often does not substitute nested ${OPENCLAW_PG_PASSWORD})
if [ -z "${OPENCLAW_MEMORY_PG_URL:-}" ] || echo "${OPENCLAW_MEMORY_PG_URL:-}" | grep -q '\$OPENCLAW_PG_PASSWORD'; then
  export OPENCLAW_MEMORY_PG_URL="postgresql://${OPENCLAW_PG_USER:-openclaw}:${OPENCLAW_PG_PASSWORD:?set OPENCLAW_PG_PASSWORD in .env}@postgres:5432/${OPENCLAW_PG_DB:-openclaw}"
fi

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/state/.openclaw/workspace}"
TEMPLATE_DIR="/app/docs/reference/templates"
PERSONAL_TEMPLATE_DIR="${OPENCLAW_PERSONAL_TEMPLATES_DIR:-/personal-templates}"

mkdir -p "$WORKSPACE_DIR"

seed_from_template() {
  local name="$1"
  local dest="${WORKSPACE_DIR}/${name}"
  # Only seed if file doesn't exist (preserve user edits)
  if [ -f "$dest" ]; then
    return 0
  fi
  # Prefer personal templates over base templates
  local src=""
  if [ -d "$PERSONAL_TEMPLATE_DIR" ] && [ -f "${PERSONAL_TEMPLATE_DIR}/${name}" ]; then
    src="${PERSONAL_TEMPLATE_DIR}/${name}"
  elif [ -f "${TEMPLATE_DIR}/${name}" ]; then
    src="${TEMPLATE_DIR}/${name}"
  fi
  if [ -n "$src" ] && [ -f "$src" ]; then
    # Strip front-matter from templates (YAML between --- markers)
    # Templates have YAML front-matter that should be removed when seeding workspace
    # This matches the behavior of stripFrontMatter() in workspace.ts:
    # - If content starts with "---", find "\n---" (second --- marker)
    # - Extract everything after second "---" and trim leading whitespace
    if head -n 1 "$src" | grep -q "^---$"; then
      # Find the second --- marker (on its own line) and extract everything after it
      # Then trim leading whitespace
      awk '
        BEGIN { count = 0 }
        /^---$/ {
          count++
          if (count == 2) {
            next
          }
        }
        count >= 2 { print }
      ' "$src" | sed 's/^[[:space:]]*//' > "$dest" || cp "$src" "$dest"
    else
      cp "$src" "$dest"
    fi
  fi
}

# Seed all workspace template files if missing.
# Note: Immutable files (SOUL.md, IDENTITY.md, USER.md) are mounted read-only from host,
# but we seed them here as fallback if host mounts aren't present.
seed_from_template "AGENTS.md"
seed_from_template "SOUL.md"
seed_from_template "IDENTITY.md"
seed_from_template "USER.md"
seed_from_template "SOUL_PLUS.md"
seed_from_template "IDENTITY_PLUS.md"
seed_from_template "USER_PLUS.md"
seed_from_template "TOOLS.md"
seed_from_template "HEARTBEAT.md"
seed_from_template "BOOT.md"
seed_from_template "WORKSPACE_RULES.md"
seed_from_template "OPERATING_PROCEDURES.md"

# Seed BOOTSTRAP.md only if:
# 1. It doesn't exist, AND
# 2. No session transcripts exist (first run)
# The agent should delete BOOTSTRAP.md after completing bootstrap (per template instructions).
if [ ! -f "${WORKSPACE_DIR}/BOOTSTRAP.md" ]; then
  if ! ls /state/agents/*/sessions/*.jsonl >/dev/null 2>&1; then
    seed_from_template "BOOTSTRAP.md"
  fi
fi

# Validate config file doesn't contain placeholders (if config path is set)
if [ -n "${OPENCLAW_CONFIG_PATH:-}" ] && [ -f "${OPENCLAW_CONFIG_PATH}" ]; then
  if grep -q "YOUR_DISCORD_GUILD_ID\|YOUR_DISCORD_CHANNEL_ID\|YOUR_DISCORD_USER_ID" "${OPENCLAW_CONFIG_PATH}" 2>/dev/null; then
    echo "ERROR: Config file contains placeholder values that must be replaced:" >&2
    echo "  File: ${OPENCLAW_CONFIG_PATH}" >&2
    echo "  Placeholders found: YOUR_DISCORD_GUILD_ID, YOUR_DISCORD_CHANNEL_ID, or YOUR_DISCORD_USER_ID" >&2
    echo "" >&2
    echo "Please edit the config file and replace these placeholders with your actual Discord IDs." >&2
    echo "See README.md for instructions on how to find your Discord IDs." >&2
    exit 1
  fi
fi

if [ "${OPENCLAW_STARTUP_INDEX:-1}" != "0" ]; then
  STATUS_JSON="$(node /app/dist/index.js memory status --json 2>/dev/null || true)"
  printf '%s' "$STATUS_JSON" | node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8").trim();
try {
  const data = JSON.parse(input);
  if (!Array.isArray(data) || data.length === 0) {
    process.exit(0);
  }
  const total = data.reduce((acc, entry) => acc + Number(entry?.status?.chunks ?? 0), 0);
  process.exit(total > 0 ? 1 : 0);
} catch {
  process.exit(0);
}
'
  NEED_INDEX=$?
  if [ "$NEED_INDEX" -eq 0 ]; then
    for _ in 1 2 3 4 5; do
      if node /app/dist/index.js memory index; then
        break
      fi
      sleep 3
    done
  fi
fi
# Ensure sourced script exits 0 so "source script && node gateway" always starts the gateway
true
