#!/usr/bin/env bash
# Zorg MemoryDB overlay rule: install/upgrade must be additive to upstream OpenClaw and preserve existing OpenClaw behavior/user data unless an explicit migration documents otherwise. Permanent engineering rules are documented in docs/base-install-permanent-engineering-rules.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_WORKSPACE="${OPENCLAW_WORKSPACE:-${1:-}}"
if [ -z "$TARGET_WORKSPACE" ]; then
  cat >&2 <<'EOF'
Usage:
  OPENCLAW_WORKSPACE=/path/to/existing/openclaw/workspace ./scripts/upgrade_existing_openclaw.sh
  ./scripts/upgrade_existing_openclaw.sh /path/to/existing/openclaw/workspace
EOF
  exit 2
fi
TARGET_WORKSPACE="$(cd "$TARGET_WORKSPACE" && pwd)"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-openclaw_memory}"
DB_USER="${DB_USER:-openclaw_memory}"
export DB_HOST DB_PORT DB_NAME DB_USER

log(){ printf '[Zorg MemoryDB upgrade] %s\n' "$*"; }

ensure_python_env(){
  cd "$TARGET_WORKSPACE"
  if [ -n "${SQLMEM_PYTHON:-}" ] && [ -x "$SQLMEM_PYTHON" ]; then
    PYTHON="$SQLMEM_PYTHON"
  elif [ -x .venv-sqlmem/bin/python ]; then
    PYTHON=".venv-sqlmem/bin/python"
  else
    log "creating Python environment in existing OpenClaw workspace"
    if python3 -m venv .venv-sqlmem >/dev/null 2>&1; then
      PYTHON=".venv-sqlmem/bin/python"
    elif python3 - <<'PY' >/dev/null 2>&1
import psycopg2
PY
    then
      PYTHON="python3"
    else
      log "python3 venv support is unavailable and psycopg2 is not installed"
      log "install python3-venv or set SQLMEM_PYTHON to a Python that has psycopg2"
      exit 1
    fi
  fi
  if ! "$PYTHON" - <<'PY' >/dev/null 2>&1
import psycopg2
PY
  then
    log "installing database driver"
    "$PYTHON" -m pip install --upgrade pip >/dev/null
    "$PYTHON" -m pip install psycopg2-binary >/dev/null
  fi
  export PYTHON
}

copy_files(){
  log "copying DB-memory tools into existing workspace"
  mkdir -p "$TARGET_WORKSPACE/scripts" "$TARGET_WORKSPACE/config" "$TARGET_WORKSPACE/db"
  cp "$REPO_ROOT/scripts/memory_sql_tool.py" "$TARGET_WORKSPACE/memory_sql_tool.py"
  cp "$REPO_ROOT/scripts/memory_recall_router.py" "$TARGET_WORKSPACE/memory_recall_router.py"
  cp "$REPO_ROOT/scripts/memory_speed_test.py" "$TARGET_WORKSPACE/memory_speed_test.py"
  cp "$REPO_ROOT/scripts/enforce_db_memory_search.py" "$TARGET_WORKSPACE/scripts/enforce_db_memory_search.py"
  cp "$REPO_ROOT/scripts/import_markdown_memory.py" "$TARGET_WORKSPACE/scripts/import_markdown_memory.py"
  cp "$REPO_ROOT/scripts/archive_retired_memory_dir.py" "$TARGET_WORKSPACE/scripts/archive_retired_memory_dir.py"
  cp "$REPO_ROOT/scripts/db_only_memory_autoheal.py" "$TARGET_WORKSPACE/scripts/db_only_memory_autoheal.py"
  cp "$REPO_ROOT/scripts/postgres_memory_backup.sh" "$TARGET_WORKSPACE/scripts/postgres_memory_backup.sh"
  cp "$REPO_ROOT/scripts/install_lan_chat.sh" "$TARGET_WORKSPACE/scripts/install_lan_chat.sh"
  cp "$REPO_ROOT/db/schema.sql" "$TARGET_WORKSPACE/db/schema.sql"
  cp "$REPO_ROOT/db/memory_file_archive_schema.sql" "$TARGET_WORKSPACE/db/memory_file_archive_schema.sql"
  cp "$REPO_ROOT/db/public_canonical_rules_update_2026_06_02.sql" "$TARGET_WORKSPACE/db/public_canonical_rules_update_2026_06_02.sql"
  cp "$REPO_ROOT/db/runtime_db_only_memory_writer_rules_2026_06_04.sql" "$TARGET_WORKSPACE/db/runtime_db_only_memory_writer_rules_2026_06_04.sql"
  mkdir -p "$TARGET_WORKSPACE/lan-chat"
  cp -R "$REPO_ROOT/lan-chat/." "$TARGET_WORKSPACE/lan-chat/"
  chmod +x "$TARGET_WORKSPACE/memory_sql_tool.py" "$TARGET_WORKSPACE/memory_recall_router.py" "$TARGET_WORKSPACE/memory_speed_test.py" "$TARGET_WORKSPACE/scripts/enforce_db_memory_search.py" "$TARGET_WORKSPACE/scripts/import_markdown_memory.py" "$TARGET_WORKSPACE/scripts/archive_retired_memory_dir.py" "$TARGET_WORKSPACE/scripts/db_only_memory_autoheal.py" "$TARGET_WORKSPACE/scripts/postgres_memory_backup.sh" "$TARGET_WORKSPACE/scripts/install_lan_chat.sh"
}

write_config(){
  cd "$TARGET_WORKSPACE"
  log "writing database memory config"
  "$PYTHON" - <<'PY'
import json, os
cfg={
  "postgres": {
    "host": os.environ["DB_HOST"],
    "port": int(os.environ["DB_PORT"]),
    "database": os.environ["DB_NAME"],
    "user": os.environ["DB_USER"]
  },
  "table_map": {
    "AGENTS.md": "md_agents",
    "SOUL.md": "md_soul",
    "USER.md": "md_user",
    "TOOLS.md": "md_tools",
    "IDENTITY.md": "md_identity",
    "HEARTBEAT.md": "md_heartbeat"
  }
}
open("sql_memory_map.json","w",encoding="utf-8").write(json.dumps(cfg, indent=2)+"\n")
PY
}

can_connect_db(){
  cd "$TARGET_WORKSPACE"
  "$PYTHON" - <<'PY' >/dev/null 2>&1
import json, psycopg2
cfg=json.load(open('sql_memory_map.json'))['postgres']
conn=psycopg2.connect(host=cfg['host'],port=cfg['port'],dbname=cfg['database'],user=cfg['user'])
conn.close()
PY
}

start_postgres_if_needed(){
  if can_connect_db; then return 0; fi
  cd "$REPO_ROOT"
  if command -v docker >/dev/null 2>&1; then
    log "starting bundled PostgreSQL"
    if docker compose version >/dev/null 2>&1; then
      docker compose up -d postgres >/dev/null
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose up -d postgres >/dev/null
    fi
    for _ in $(seq 1 40); do
      if can_connect_db; then return 0; fi
      sleep 2
    done
  fi
  if command -v createdb >/dev/null 2>&1; then
    createdb "$DB_NAME" >/dev/null 2>&1 || true
  fi
  can_connect_db
}

apply_schema(){
  cd "$TARGET_WORKSPACE"
  log "applying memory database schema"
  "$PYTHON" - <<'PY'
import json, pathlib, psycopg2
cfg=json.load(open('sql_memory_map.json'))['postgres']
schema=pathlib.Path('db/schema.sql').read_text(encoding='utf-8')
public_rules=pathlib.Path('db/public_canonical_rules_update_2026_06_02.sql')
runtime_rules=pathlib.Path('db/runtime_db_only_memory_writer_rules_2026_06_04.sql')
conn=psycopg2.connect(host=cfg['host'],port=cfg['port'],dbname=cfg['database'],user=cfg['user'])
with conn:
    with conn.cursor() as cur:
        cur.execute(schema)
        if public_rules.exists():
            cur.execute(public_rules.read_text(encoding='utf-8'))
        if runtime_rules.exists():
            cur.execute(runtime_rules.read_text(encoding='utf-8'))
        cur.execute('select refresh_zorg_memory_search_mv();')
        cur.execute('select refresh_zorg_memory_search_fast_mv();')
        cur.execute('select refresh_zorg_master_context();')
conn.close()
PY
}

install_lan_chat(){
  if [ "${ZORG_SKIP_LAN_CHAT_INSTALL:-0}" = "1" ]; then
    log "LAN command chat install skipped by ZORG_SKIP_LAN_CHAT_INSTALL=1"
    return 0
  fi

  log "installing built-in LAN command chat"
  OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}" \
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" \
  INSTALL_DIR="$TARGET_WORKSPACE" \
  LAN_CHAT_DIR="$TARGET_WORKSPACE/lan-chat" \
  LAN_CHAT_PORT="${LAN_CHAT_PORT:-3001}" \
  GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}" \
  GATEWAY_SESSION_KEY="${GATEWAY_SESSION_KEY:-agent:main:main}" \
  CHAT_SOURCE_LABEL="${CHAT_SOURCE_LABEL:-LAN Console}" \
  CHAT_HISTORY_LIMIT="${CHAT_HISTORY_LIMIT:-20}" \
  "$TARGET_WORKSPACE/scripts/install_lan_chat.sh"
}

append_rules(){
  cd "$TARGET_WORKSPACE"
  log "updating OpenClaw markdown files with DB-memory rules"
  touch AGENTS.md SOUL.md TOOLS.md
  if [ ! -f ZORG_MEMORYDB_MASTER_RULES.md ] && [ -f "$REPO_ROOT/templates/ZORG_MEMORYDB_MASTER_RULES.md" ]; then
    cp "$REPO_ROOT/templates/ZORG_MEMORYDB_MASTER_RULES.md" ZORG_MEMORYDB_MASTER_RULES.md
  fi
  marker='<!-- ZORG_MEMORYDB_RULES -->'
  block='<!-- ZORG_MEMORYDB_RULES -->

## Zorg MemoryDB Rules

- Check database memory before acting.
- Use DB-backed recall only; retired flat-file memory surfaces must not be used as fallback.
- Import existing legacy markdown memory into the DB archive/line index once, then remove the retired memory/ directory.
- Preserve original memory history; improve recall additively with indexes, views, summaries, and relationship tables.

## Executive Assistant Operating Rules

- Protect the operator time by filtering noise, reducing decision load, and closing loops.
- Communicate clearly, kindly, and with enough context to make the next action obvious.
- Treat calendar time as scarce inventory; include purpose, attendees, link/location, prep, decision needed, and buffer/travel time where useful.
- Triage inbox by importance, relationship, urgency, revenue impact, risk, and whether the operator personally must respond.
- Reply only when authorized; otherwise draft with context and request approval.
- Send outbound email as rich text/HTML with a plain-text fallback by default; hard-coded Gmail/API send paths should use multipart/alternative, not text/plain-only, unless HTML is technically unsupported, objectively risky, deliverability-risky, or explicitly requested.
- Be preemptive: identify risks, blockers, dependencies, and options before they become operator problems.
- Prioritize revenue, profit, avoided loss, strategic leverage, and time recovered.
- Safeguard credentials, private calendar details, contact data, family details, financial data, and sensitive business context; use least disclosure.
- Apply private communication filters silently: assume operator-provided information is private by default unless explicitly marked public/shareable, combine public facts, relationship context, and private handling instructions to shape outward messages, ask before disclosing uncertain private details, and never expose private strategy.
- Avoid static workflow framing for agent-owned dynamic behavior unless describing literal fixed automation; continuously explore better language for adaptive memory/context/rule/tool/judgment-driven execution without locking onto one term too early.
- Recover from email-address failures proactively: search memory/contacts/history/public sources, confirm corrected recipient, resend intended messages with a wrong-address/delay apology, and escalate only uncertain or risky cases.
- Treat DB repair/restore as the emergency path for DB failure: attempt safe repair first; if repair fails, search predictable DB backup paths, test backups until one verifies, promote it, refresh recall, and run DB health/recall tests before claiming recovery. Do not create flat-file memory as fallback.
- Treat operator prosperity, safety, reputation, time, and operational continuity as the organizing purpose for memory and follow-through; preserve accumulated knowledge to serve the operator better, not as independent self-preservation.
- Handle bounced email without repetition: report only unread email, mark reported messages read, delete known-bad bounce notices with narrow matching, recover/confirm corrected addresses, resend intended messages, and apologize for wrong-address delays.
- When authorized business contact fails, do not stop at a bounce; use structured memory, CRM records, prior correspondence, official websites, and public contact pages to find a credible alternate route before escalating.
<!-- /ZORG_MEMORYDB_RULES -->
'
  for file in AGENTS.md SOUL.md TOOLS.md; do
    if ! grep -q "$marker" "$file"; then
      printf '\n%s\n' "$block" >> "$file"
    fi
  done
}

import_and_verify(){
  cd "$TARGET_WORKSPACE"
  log "archiving retired memory/ directory into database, if present"
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" SQL_MEMORY_MAP="$TARGET_WORKSPACE/sql_memory_map.json" "$PYTHON" scripts/archive_retired_memory_dir.py >/dev/null
  log "importing core markdown rules into database"
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" SQL_MEMORY_MAP="$TARGET_WORKSPACE/sql_memory_map.json" "$PYTHON" scripts/import_markdown_memory.py >/dev/null
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" SQL_MEMORY_MAP="$TARGET_WORKSPACE/sql_memory_map.json" "$PYTHON" memory_sql_tool.py refresh >/dev/null
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" SQL_MEMORY_MAP="$TARGET_WORKSPACE/sql_memory_map.json" "$PYTHON" memory_sql_tool.py tables
  log "existing OpenClaw workspace is now attached to DB memory"
}

enforce_builtin_memory_search(){
  cd "$TARGET_WORKSPACE"
  log "enforcing DB-backed built-in memory_search routing"
  OPENCLAW_WORKSPACE="$TARGET_WORKSPACE" SQL_MEMORY_MAP="$TARGET_WORKSPACE/sql_memory_map.json" "$PYTHON" scripts/enforce_db_memory_search.py >/dev/null || \
    log "built-in memory_search enforcement skipped; run scripts/enforce_db_memory_search.py after OpenClaw is installed"
}

ensure_python_env
copy_files
write_config
start_postgres_if_needed || { log "could not reach PostgreSQL. Start PostgreSQL/Docker or provide DB_* env vars, then rerun."; exit 1; }
apply_schema
append_rules
import_and_verify
enforce_builtin_memory_search
install_lan_chat
