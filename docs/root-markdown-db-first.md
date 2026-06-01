# Root Markdown DB-First Policy

OpenClaw/Zorg runtime workspaces keep root markdown files small. Durable operating rules, process rules, user/project history, and other long-lived context belong in PostgreSQL-backed Zorg MemoryDB tables, not in oversized markdown files.

Root markdown files should contain only the minimum bootstrap pointer needed to recover the backend memory database and verify DB-backed recall. The canonical local repair pointer is `ZORG_MEMORYDB_MASTER_RULES.md`; workspace entry files such as `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, and `HEARTBEAT.md` may point to that recovery file but should not duplicate the full rule corpus.

Before shrinking existing root markdown, sync current rules into structured DB recall:

```bash
cd /home/openclaw/.openclaw/workspace
/home/openclaw/.openclaw/workspace/.venv-sqlmem/bin/python \
  /home/openclaw/.openclaw/workspace/scripts/sync_core_rules_to_logic_rules.py
```

After shrinking markdown files, re-import the reduced line tables and refresh recall views:

```bash
cd /home/openclaw/.openclaw/workspace
OPENCLAW_WORKSPACE=/home/openclaw/.openclaw/workspace \
  /home/openclaw/.openclaw/workspace/.venv-sqlmem/bin/python \
  /home/openclaw/.openclaw/workspace/Zorg_MemoryDB/scripts/import_markdown_memory.py
```

Verify the result with:

```bash
/home/openclaw/.openclaw/workspace/memory_sql_tool.py tables
/home/openclaw/.openclaw/workspace/memory_sql_tool.py search "backend memory repair database recall" --table all --limit 10
/home/openclaw/.openclaw/workspace/memory_speed_test.py
```

The retired `memory/` directory remains unavailable as a fallback. If DB recall is unavailable, repair or restore the DB path instead of recreating flat-file memory.
