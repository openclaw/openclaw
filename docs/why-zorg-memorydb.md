# Why Zorg MemoryDB

Zorg MemoryDB makes assistant continuity database-backed instead of markdown-file-backed. The goal is a memory system that can survive restarts, upgrades, migrations, and recall failures while keeping private operator data out of public repositories.

The public repository carries only structure: schema, scripts, install paths, recovery procedures, public-safe rules, and documentation. Live database rows, transcripts, contacts, credentials, account data, emails, and private operator context remain local or in private backup stores.

## Design goals

1. **DB-backed recall first.** Agents should query PostgreSQL-backed recall before making decisions, and DB recall should be repaired or restored when it is unavailable.
2. **Small root markdown.** Root `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, and `HEARTBEAT.md` files are bootstrap pointers. Durable rule bodies live in structured DB recall.
3. **No flat-file fallback.** The retired `memory/` directory is archive input only. It must not be recreated for daily notes, project notes, source notes, or heartbeat state.
4. **Additive evolution.** Recall quality improves through semantic nodes, weighted edges, recall hints, query observations, materialized views, and indexes while preserving source rows.
5. **Recoverability.** Schema, backup, restore, and verification procedures must be clear enough for a future agent to recover memory service from public-safe docs plus private backups.
6. **LLM-governed operations.** Dynamic policy decisions stay in live LLM judgment, DB-backed rules, runbooks, and current state. Helper scripts should remain narrow mechanical tools.

## What ships publicly

The public package can include:

- PostgreSQL schema and seed rules
- import, recall, backup, recovery, and install helpers
- public-safe documentation and release notes
- sanitized templates and baseline configuration

It must not include:

- live memory rows or database dumps
- contacts, email contents, transcripts, credentials, or account data
- private operator strategy or relationship context
- generated private logs from runtime tasks

## Operational contract

A healthy install proves both ingestion and recall. It should show recent durable facts arriving in PostgreSQL, natural-language recall finding those facts, no retired markdown memory output being recreated, and recovery drills or backup paths available for database failure.
