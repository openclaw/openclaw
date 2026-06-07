# Native Linux Install

This path installs OpenClaw natively from a Zorg MemoryDB branch of the original `openclaw/openclaw` repository. The installer has a prerequisite repair phase before it runs OpenClaw or npm, so a host with missing or too-old base software is repaired first instead of failing halfway through the install.

## Install

```bash
git clone https://github.com/<your-account>/openclaw.git "$HOME/openclaw"
cd "$HOME/openclaw"
git checkout zorg-memorydb
./scripts/install_standard_ubuntu.sh
```

What it does:

1. detects the host package manager and installs base packages needed for OpenClaw, PostgreSQL-backed memory, and the LAN command console
2. checks Node.js and npm before npm is used, upgrades missing or too-old Node to Node >= 22.19.0, repairs a missing npm when Node is already new enough, and fails early with a clear message if the OS cannot provide a compatible Node/npm runtime
3. clones or updates the OpenClaw fork/branch into `$HOME/openclaw`
4. installs OpenClaw from that same git checkout with OpenClaw's official `--install-method git` path
5. starts local PostgreSQL using the available service manager
6. creates the local OpenClaw memory role/database with local trust access
7. writes `sql_memory_map.json` into `$HOME/.openclaw/workspace`
8. applies the Zorg MemoryDB schema, recall surfaces, and the 104-rule public canonical rule seed from the single packaged add-on rule file
9. installs and builds the built-in LAN command console from `./lan-chat`
10. registers `lan-chat.service` as a user-level systemd service on port `3001`
11. starts OpenClaw with memory already wired

The automatic prerequisite path currently recognizes `apt`, `dnf`, `yum`, `zypper`, `apk`, `pacman`, and `brew`. Debian and Ubuntu hosts use NodeSource for Node 22 when the distribution package is missing or too old, and the same repair path is used when Node is present but npm is missing.

## Start OpenClaw after install

```bash
cd "$HOME/.openclaw/workspace"
source .env.native
OPENCLAW_WORKSPACE=$PWD SQL_MEMORY_MAP=$PWD/sql_memory_map.json openclaw gateway run --allow-unconfigured --bind "$OPENCLAW_GATEWAY_BIND" --port "$OPENCLAW_GATEWAY_PORT" --auth "$OPENCLAW_GATEWAY_AUTH"
```

## LAN command console

The native installer also runs `./scripts/install_lan_chat.sh`. The console is installed as:

```bash
systemctl --user status lan-chat.service
```

Default local URL:

```text
http://127.0.0.1:3001/
```

## Verify

```bash
cd "$HOME/.openclaw/workspace"
.venv-sqlmem/bin/python scripts/memory_sql_tool.py tables
.venv-sqlmem/bin/python scripts/memory_recall_router.py "database memory" --limit 5
curl -fsS http://127.0.0.1:${LAN_CHAT_PORT:-3001}/ | grep -i '<title>'
```

Expected recall mode: `database-direct-structured`.

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

## Permanent engineering rules

System changes, code writing, and software changes are governed by permanent base-install rules, not personal preferences. See [`base-install-permanent-engineering-rules.md`](base-install-permanent-engineering-rules.md). Zorg MemoryDB must be installed/upgraded as an additive OpenClaw overlay that preserves existing OpenClaw behavior and user data unless an explicit migration says otherwise.
