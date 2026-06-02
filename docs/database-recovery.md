# Database Backup, Repair, and Recovery Rule

This is a top-level hard rule for Zorg MemoryDB installs.

A future agent or large language model must be able to recover memory service even if the active database is badly corrupted and normal DB recall is unavailable. Public markdown docs are the recovery map; durable private memory belongs in PostgreSQL and local/operator-approved private backup systems, never in the public repository. The docs must clearly tell the next agent where local rollback backups live, what to try first, and how to verify recovery.

## Hard rule

1. **Backups must be predictable.** Production structural changes require a verified temporary local PostgreSQL backup in a predictable location so any future model can find it from documentation alone.
2. **Repair first.** If the active database is inaccessible or corrupted, attempt safe database repair first when possible.
3. **Recover from backup if repair fails.** If repair cannot restore a working DB, search the predictable backup locations and test backup versions until a working one is found.
4. **Promote the first verified working backup.** Restore the first backup that passes health and recall verification, then use it as the active database going forward.
5. **Verify before claiming success.** After repair or restore, run database health and recall tests before declaring the system fixed.
6. **Never delete source memory to recover performance.** Recovery may rebuild derived views/indexes/caches, but original/source memory should be preserved.
7. **Do not push DB dumps to GitHub.** Do not commit, mirror, or push live database dumps, rows, contacts, transcripts, credentials, or private memory to GitHub from the public MemoryDB update path. Off-host recovery can be a separately approved encrypted/private operations process.

## Filesystem resurrection pointer

Live Zorg/OpenClaw workspaces should keep a tiny root-level
`RESURRECTION.md`. That file is intentionally outside PostgreSQL so a fresh
agent can recover even when database recall is damaged, empty, or unavailable.
The root bootstrap files (`AGENTS.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`,
`IDENTITY.md`, and `USER.md`) should point to it before the database-only
memory guidance.

The resurrection file must include local backup paths, any separately approved
private mirror paths, the backup script, the restore/drill script, manual restore
fallback commands, post-restore recall verification commands, and a reminder
that retired durable markdown memory is not a fallback.

Backups are not operationally meaningful unless this filesystem restore path
exists and can be found without querying the broken database.

## Predictable backup locations

Use these locations in order. Local temporary rollback paths are the default.
Encrypted/private off-host recovery belongs to a separately approved operations
setup.

1. `$OPENCLAW_WORKSPACE/backups/database/`
2. `$OPENCLAW_WORKSPACE/backups/postgres/`
3. `$OPENCLAW_HOME/backups/database/`
4. `$OPENCLAW_HOME/backups/postgres/`
5. `/home/openclaw/.openclaw/backups/database/`
6. `/home/openclaw/.openclaw/backups/postgres/`
7. temporary local PostgreSQL dump path, such as `/home/openclaw/.openclaw/backups/postgres/tmp/`
8. optional encrypted/private off-host mirror only when separately approved and configured

Recommended filename pattern:

```text
zorg-memorydb-YYYYMMDD-HHMMSS.dump
zorg-memorydb-YYYYMMDD-HHMMSS.sql.gz
zorg-memorydb-YYYYMMDD-HHMMSS.pgcustom
```

Backups may be PostgreSQL custom-format dumps, compressed SQL dumps, or implementation-specific snapshots, but they should be named clearly and stored under the predictable directories above.

## Scripted recovery requirement

Backups are not considered useful until a scripted recovery drill can prove that at least one dump restores into an isolated test database and passes schema/row-count checks. The canonical public-safe script is:

```bash
bash scripts/postgres_memory_recovery.sh list
bash scripts/postgres_memory_recovery.sh drill
bash scripts/postgres_memory_recovery.sh drill /path/to/zorgdb-YYYY-MM-DD_HHMMSS.sql.gz
```

The drill creates a temporary PostgreSQL database inside the configured container, restores the selected dump, verifies that `public.zorg_memory` exists and has rows, then drops the temporary database. It does not replace the live database.

Live restore is intentionally gated:

```bash
CONFIRM_RESTORE_ACTIVE=YES bash scripts/postgres_memory_recovery.sh restore-active /path/to/zorgdb-YYYY-MM-DD_HHMMSS.sql.gz
```

The live restore path first runs the drill against the selected dump. If the drill passes, it renames the current live database to a safety database, creates a fresh live database, restores the selected dump, and verifies the restored live database. This still requires operator approval because it replaces active service state.

## Before production DB tuning or schema changes

Before any production DB structural, indexing, materialized-view, recall-routing, vector/embedding, weighted-association, neural-memory, or schema change:

1. create a temporary local PostgreSQL backup
2. verify that the local rollback dump can be located and, when practical, drilled
3. confirm the change is justified by a real recall failure where data existed in DB but did not return on first-pass recall and was found only through deeper/alternate/manual search
4. if no recall failure exists, restrict work to benchmarks, sandbox/temp experiments, and additive design proposals

Never place private DB dumps in the public `Zorg_MemoryDB` repository.

## Repair-first process

When the database appears broken:

1. Read markdown rules first, because DB recall may be unavailable.
2. Identify the active OpenClaw workspace and home:
   - `OPENCLAW_WORKSPACE`, if set
   - otherwise `/home/openclaw/.openclaw/workspace`
   - `OPENCLAW_HOME`, if set
   - otherwise `/home/openclaw/.openclaw`
3. Check PostgreSQL availability:

```bash
pg_isready -h 127.0.0.1 -p 5432 || true
```

4. Try safe repair steps appropriate to the install:
   - restart only the DB service/container if the service is down
   - run `ANALYZE`/refresh materialized views if the DB is online but recall surfaces are stale
   - refresh derived recall views/functions from schema scripts when available
   - rerun import/bootstrap scripts only when they are known to be non-destructive for the current install

Suggested non-destructive checks from an OpenClaw workspace:

```bash
.venv-sqlmem/bin/python scripts/memory_sql_tool.py tables
.venv-sqlmem/bin/python scripts/memory_sql_tool.py refresh
.venv-sqlmem/bin/python scripts/memory_recall_router.py "database memory" --limit 5
```

If safe repair restores health, stop and verify. Do not restore a backup unnecessarily.

## Backup recovery process

If repair fails:

1. Search predictable backup locations.
2. Sort backups newest-first unless there is a known reason to prefer another order.
3. For each candidate backup:
   - run `scripts/postgres_memory_recovery.sh drill <candidate>` to restore into a temporary test database
   - run health and recall verification
   - reject backups that fail to restore, fail schema checks, or cannot answer recall tests
4. Restore/promote the first verified working backup to the active DB.
5. Refresh materialized views and recall surfaces.
6. Re-run verification.
7. Record which backup was used and why older/newer candidates were rejected.

Example candidate search:

```bash
find "$OPENCLAW_WORKSPACE/backups" "$OPENCLAW_HOME/backups" /home/openclaw/.openclaw/backups \
  -type f \( -name '*.dump' -o -name '*.sql.gz' -o -name '*.pgcustom' -o -name '*postgres*' -o -name '*memorydb*' \) \
  2>/dev/null | sort -r
```

## Verification after repair or recovery

A database is not recovered until tests pass.

Minimum checks:

```bash
pg_isready -h 127.0.0.1 -p 5432
cd /home/openclaw/.openclaw/workspace
.venv-sqlmem/bin/python scripts/memory_sql_tool.py tables
.venv-sqlmem/bin/python scripts/memory_sql_tool.py refresh
.venv-sqlmem/bin/python scripts/memory_recall_router.py "database memory recovery verification" --limit 5
```

For packaged repo testing:

```bash
bash -n scripts/*.sh docker/entrypoint.sh
python3 -m py_compile scripts/*.py
docker compose config >/tmp/zorg-memorydb-compose.yml
```

Expected result:

- PostgreSQL is reachable.
- Zorg memory tables are visible.
- Materialized views refresh successfully.
- Recall router returns DB-backed results or a clearly explained empty result with DB mode active.
- OpenClaw memory_search routing remains enforced when runtime files are available.

## What to report

Stay concise, but include:

- whether repair succeeded or backup recovery was required
- backup path used, if any
- candidates tested/rejected, if relevant
- final DB health/recall verification result
- any data-loss risk or unresolved blocker

## Public-safety note

Do not publish database backups, dumps, private memory rows, transcripts, contacts, emails, credentials, account data, or operator context to the public `Zorg_MemoryDB` repository. Public docs should describe structure and recovery procedure only.

<!-- SCORCHED_MEMORY_RECALL_RULE -->

## Absolute Priority 0: Exhaustive Memory Before Response

The operator does not ask for work in context unless the needed information, access path, rule, contact, precedent, or working solution likely already exists somewhere in durable memory, project history, live configuration, runbooks, prompts, cron jobs, or related system state. A fast or shallow miss is never evidence of absence.

Before replying, asking a question, claiming uncertainty, or reporting a blocker, the assistant must scour the backend memory system deeply and creatively: use broader queries, alternate names, relationship terms, adjacent projects, prior similar tasks, contact records, operational history, runbooks, cron payloads, and live configuration clues until the relevant context is found or genuinely exhausted. Immediate answers are disallowed when memory could contain the answer.

If deep scouring finds information that the first query missed, treat that as a recall-structure failure and immediately add additive retrieval support: aliases, recall hints, semantic/relationship edges, query observations, indexes, materialized/search support, or rule surfaces so the same phrasing is fast and reliable next time. Preserve all source data; improve recall additively only.

Failure reports must not excuse the miss as “not enough information” when the information existed in memory. The correct diagnosis is inadequate recall behavior or structure, and the corrective action is deeper recall plus indexing/hinting/relationship repair.

<!-- /SCORCHED_MEMORY_RECALL_RULE -->

<!-- LLM_GOVERNED_PERFORMANCE_TUNING_RULE -->

## LLM-Governed Performance Tuning Rule

Database and memory performance tuning must be governed by live LLM judgment, not hidden script policy. Tuning work starts with a natural-language hypothesis formed from current system evidence and internet/authoritative research. If research gives a credible reason to believe a database design, recall-path, materialized-view, vector/neural association, or query-structure change will improve performance, the LLM must run side-by-side before/after measurements on representative queries before claiming success.

If research does not support a design change, move to raw additive performance work: indexes, query-path improvements, materialized/search-support views, relationships, recall hints, semantic edges, weighted connections, token/FTS/trigram support, and other non-destructive logic that brings query times down while preserving all source memory. No original memory data may be pruned, deleted, truncated, compacted away, or aged out for speed.

Every meaningful tuning change must record the research basis, before/after benchmark results, changed structures, rollback path, and follow-up indexing/hinting implications in durable memory and public-safe docs when structural behavior changes.

<!-- /LLM_GOVERNED_PERFORMANCE_TUNING_RULE -->

<!-- GO_ONLY_APPROVAL_RULE -->

## GO-Only Approval Rule

When Stefan gives a command that requires confirmation before execution, ask only for `GO`. Do not invent longer approval phrases, magic words, task-specific confirmations, or exact response strings such as `GO REIP ...`, `GO SCORCHED ...`, or any other expanded form. Stefan decides how to respond; the assistant may request only the simple approval token `GO`.

If the requested action is unsafe, ambiguous, destructive, externally risky, or missing a necessary decision, explain the blocker or the exact intended change briefly, then end with only `GO` as the approval request when approval is the only thing needed. Never require Stefan to repeat the task, include extra words, or match an assistant-authored phrase.

<!-- /GO_ONLY_APPROVAL_RULE -->

<!-- SAME_DAY_NEWS_FRESHNESS_RULE -->

## Same-Day News Freshness Rule

When writing multiple news articles or public reports on the same day, do not repeat the same information from article to article. Adjacent or continuing stories may reference earlier context only briefly when necessary, but each article must add fresh facts, new framing, new implications, new examples, or a clearly advanced continuation that was not already covered in earlier same-day articles.

Before drafting or publishing a new article, review the same-day feed/archive and compare titles, summaries, body claims, examples, and links. If information has already been used that day, either omit it, compress it to a short bridge, or explicitly advance it with new developments. Maintain editorial continuity without recycling paragraphs, talking points, examples, or conclusions.

The assistant owns the full article set and must keep the day’s coverage fresh, non-repetitive, and additive.

<!-- /SAME_DAY_NEWS_FRESHNESS_RULE -->
