#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-openclaw_memory}"
DB_USER="${DB_USER:-openclaw_memory}"
export DB_HOST DB_PORT DB_NAME DB_USER

log(){ printf '[Zorg MemoryDB] %s\n' "$*"; }

ensure_python_env(){
  if [ -n "${SQLMEM_PYTHON:-}" ] && [ -x "$SQLMEM_PYTHON" ]; then
    PYTHON="$SQLMEM_PYTHON"
  elif [ -x .venv-sqlmem/bin/python ]; then
    PYTHON=".venv-sqlmem/bin/python"
  else
    log "creating Python environment"
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

write_config(){
  if [ ! -f sql_memory_map.json ] || [ "${ZORG_FORCE_WRITE_CONFIG:-0}" = "1" ]; then
    log "creating sql_memory_map.json"
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
  fi
}

can_connect_db(){
  "$PYTHON" - <<'PY' >/dev/null 2>&1
import json, psycopg2
cfg=json.load(open('sql_memory_map.json'))['postgres']
conn=psycopg2.connect(host=cfg['host'],port=cfg['port'],dbname=cfg['database'],user=cfg['user'])
conn.close()
PY
}

start_postgres_if_needed(){
  if can_connect_db; then
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    log "starting bundled PostgreSQL"
    if docker compose version >/dev/null 2>&1; then
      docker compose up -d postgres >/dev/null
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose up -d postgres >/dev/null
    else
      log "docker is present but compose is unavailable"
      return 1
    fi
    for _ in $(seq 1 40); do
      if can_connect_db; then return 0; fi
      sleep 2
    done
  fi
  if command -v createdb >/dev/null 2>&1; then
    log "trying local PostgreSQL database creation"
    createdb "$DB_NAME" >/dev/null 2>&1 || true
  fi
  can_connect_db
}

apply_schema(){
  log "applying database schema"
  "$PYTHON" - <<'PY'
import json, pathlib, psycopg2
cfg=json.load(open('sql_memory_map.json'))['postgres']
schema=pathlib.Path('zorg/db/schema.sql').read_text(encoding='utf-8')
public_rules=pathlib.Path('zorg/db/public_canonical_rules_update_2026_06_02.sql')
conn=psycopg2.connect(host=cfg['host'],port=cfg['port'],dbname=cfg['database'],user=cfg['user'])
with conn:
    with conn.cursor() as cur:
        cur.execute(schema)
        if public_rules.exists():
            cur.execute(public_rules.read_text(encoding='utf-8'))
        cur.execute('select refresh_zorg_memory_search_mv();')
        cur.execute('select refresh_zorg_memory_search_fast_mv();')
        cur.execute('select refresh_zorg_master_context();')
conn.close()
PY
}

ensure_memory_files(){
  for f in ZORG_MEMORYDB_MASTER_RULES.md AGENTS.md SOUL.md USER.md TOOLS.md IDENTITY.md HEARTBEAT.md; do
    if [ ! -f "$f" ] && [ -f "templates/$f" ]; then cp "templates/$f" "$f"; fi
  done
}

import_and_verify(){
  log "archiving retired memory/ directory into database, if present"
  OPENCLAW_WORKSPACE="$ROOT" SQL_MEMORY_MAP="$ROOT/sql_memory_map.json" "$PYTHON" scripts/archive_retired_memory_dir.py >/dev/null
  log "importing core markdown rules and refreshing recall views"
  OPENCLAW_WORKSPACE="$ROOT" SQL_MEMORY_MAP="$ROOT/sql_memory_map.json" "$PYTHON" scripts/import_markdown_memory.py >/dev/null
  OPENCLAW_WORKSPACE="$ROOT" SQL_MEMORY_MAP="$ROOT/sql_memory_map.json" "$PYTHON" scripts/memory_sql_tool.py tables >/dev/null
  log "database memory ready"
}

enforce_builtin_memory_search(){
  if command -v openclaw >/dev/null 2>&1 || [ -d "${OPENCLAW_HOME:-$HOME/.openclaw}/plugin-runtime-deps" ]; then
    log "enforcing DB-backed built-in memory_search routing"
    OPENCLAW_WORKSPACE="$ROOT" SQL_MEMORY_MAP="$ROOT/sql_memory_map.json" "$PYTHON" scripts/enforce_db_memory_search.py >/dev/null || \
      log "built-in memory_search enforcement skipped; run scripts/enforce_db_memory_search.py after OpenClaw is installed"
  fi
}

run_db_only_autoheal(){
  log "verifying DB-only memory state"
  OPENCLAW_WORKSPACE="$ROOT" SQL_MEMORY_MAP="$ROOT/sql_memory_map.json" SQLMEM_PYTHON="$PYTHON" "$PYTHON" scripts/db_only_memory_autoheal.py >/dev/null || \
    log "DB-only auto-heal reported issues; DB config/routing enforcement already ran and periodic repair can retry"
}

ensure_python_env
write_config
ensure_memory_files
start_postgres_if_needed || { log "could not reach PostgreSQL. Install/start PostgreSQL or Docker, then rerun."; exit 1; }
apply_schema
import_and_verify
enforce_builtin_memory_search
run_db_only_autoheal
