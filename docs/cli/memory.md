---
summary: "CLI reference for `openclaw memory` (status/index/search/promote/promote-explain/audit/rem-harness/rollup)"
read_when:
  - You want to index or search semantic memory
  - You're debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
title: "Memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Memory wiki: [Memory Wiki](/plugins/memory-wiki)
- Wiki CLI: [wiki](/cli/wiki)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --fix
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory promote --limit 10 --min-score 0.75
openclaw memory promote --apply
openclaw memory promote --apply --request-approval
openclaw memory promote --apply --approval-id plugin:...
openclaw memory promote --json --min-recall-count 0 --min-unique-queries 0
openclaw memory promote-explain "router vlan"
openclaw memory promote-explain "router vlan" --json
openclaw memory audit --json
openclaw memory audit --days 30 --output ./memory-curator-audit.json
openclaw memory rollup --dry-run
openclaw memory rollup --apply
openclaw memory rollup --stale
openclaw memory rollup --agent main --json
openclaw memory rem-harness
openclaw memory rem-harness --json
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

`memory status` and `memory index`:

- `--agent <id>`: scope to a single agent. Without it, these commands run for each configured agent; if no agent list is configured, they fall back to the default agent.
- `--verbose`: emit detailed logs during probes and indexing.

`memory status`:

- `--deep`: probe local vector-store readiness, embedding-provider readiness, and semantic vector-search readiness. Plain `memory status` stays fast and does not run live embedding or provider discovery work; unknown vector-store or semantic-vector state means it was not probed in that command. QMD lexical `searchMode: "search"` skips semantic vector probes and embedding maintenance even with `--deep`.
- `--index`: run a reindex if the store is dirty (implies `--deep`).
- `--fix`: repair stale recall locks and normalize promotion metadata.
- `--json`: print JSON output.

If `memory status` shows `Dreaming status: blocked`, the managed dreaming cron is enabled but the heartbeat that drives it is not firing for the default agent. See [Dreaming never runs](/concepts/dreaming#dreaming-never-runs-status-shows-blocked) for the two common causes.

`memory status` also reports these machine-verifiable metrics:

- `Index coverage`: `memory` and `session-transcripts` as `indexed/discovered` file counts.
- `Rollup coverage`: discovered/upToDate/pending/stale/orphaned rollup plan summary.
- `Rollup health` and `Coverage health` warnings when stale coverage or index drift should be investigated.

`memory index`:

- `--force`: force a full reindex.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--max-results <n>`: limit the number of results returned.
- `--min-score <n>`: filter out low-score matches.
- `--json`: print JSON results.

`memory promote`:

Preview and apply short-term memory promotions.

```bash
openclaw memory promote [--apply] [--limit <n>] [--include-promoted]
```

- `--apply` -- write promotions to `MEMORY.md` (default: preview only).
- `--request-approval` -- request an allow-once approval for approval-gated promotions and write nothing in that run.
- `--approval-id <id>` -- apply approval-gated promotions only after consuming a resolved allow-once plugin approval.
- `--limit <n>` -- cap the number of candidates shown.
- `--include-promoted` -- include entries already promoted in previous cycles.

Full options:

- Ranks short-term candidates from `memory/YYYY-MM-DD.md` using weighted promotion signals (`frequency`, `relevance`, `query diversity`, `recency`, `consolidation`, `conceptual richness`).
- Uses short-term signals from both memory recalls and daily-ingestion passes, plus light/REM phase reinforcement signals.
- When dreaming is enabled, `memory-core` auto-manages one cron job that runs a full sweep (`light -> REM -> deep`) in the background (no manual `openclaw cron add` required).
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--limit <n>`: max candidates to return/apply.
- `--min-score <n>`: minimum weighted promotion score.
- `--min-recall-count <n>`: minimum recall count required for a candidate.
- `--min-unique-queries <n>`: minimum distinct query count required for a candidate.
- `--apply`: append selected candidates into `MEMORY.md` and mark them promoted.
- `--request-approval`: create a redacted plugin approval request for candidates that the Memory & Knowledge Curator guard marks `approval_required`. The request allows only `allow-once` or `deny`; it never offers `allow-always`.
- `--approval-id <id>`: consume a resolved allow-once plugin approval and re-run the guarded promotion. Denied, expired, mismatched, or replayed approval ids write nothing.
- `--include-promoted`: include already promoted candidates in output.
- `--json`: print JSON output.

`--apply` is guarded by the Memory & Knowledge Curator runtime contract before
`MEMORY.md` is changed. Candidates with secret-like content are denied and
private-to-shared promotions require approval; the event journal records only
redacted decision telemetry.

Approval-gated promotion is a two-step flow:

```bash
openclaw memory promote --apply --request-approval --json
# approve the printed plugin approval id with allow-once in the Control UI or /approve
openclaw memory promote --apply --approval-id plugin:...
```

The second command consumes the allow-once approval atomically. Reusing the same
approval id is treated as replay and does not write to `MEMORY.md`.
The Control UI's Dreams tab can list pending Memory Curator approvals, resolve
them as `allow-once` or `deny`, and copy the exact `--approval-id` resume
command. Resolving an approval in the UI never writes durable memory by itself;
the explicit CLI apply command above is still required.

`memory audit`:

Export a non-secret Memory Curator guard audit report.

```bash
openclaw memory audit --json
openclaw memory audit --days 30 --output ./memory-curator-audit.json
```

- `--agent <id>`: scope to one agent. Without it, audit includes every configured agent workspace.
- `--days <n>`: UTC lookback window. Default is `30`; maximum is `90`.
- `--output <path>`: write the JSON report to a file.
- `--json`: print the same JSON report to stdout.

The audit report is counts and timestamps only. It includes aggregate guard
counts, alert counts, daily trend buckets, approval counts, decision counts,
last decision time, generated time, and source event counts. It never includes
raw memory content, snippets, redacted previews, source paths, approval payload
text, credentials, cookies, tokens, SSH keys, wallet data, phone numbers, or
payment identifiers.

`memory promote-explain`:

Explain a specific promotion candidate and its score breakdown.

```bash
openclaw memory promote-explain <selector> [--agent <id>] [--include-promoted] [--json]
```

- `<selector>`: candidate key, path fragment, or snippet fragment to look up.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted candidates.
- `--json`: print JSON output.

`memory rollup`:

Generate deterministic, compact summaries of session transcripts and persist them under `memory/session-rollups/<agentId>/...`.

```bash
openclaw memory rollup --dry-run
openclaw memory rollup --apply
openclaw memory rollup --stale
openclaw memory rollup --agent main --json
```

- `--agent <id>`: scope to a single agent (default: the default agent).
- `--apply`: write generated rollups to disk (default is dry-run preview only).
- `--stale`: list stale or orphaned rollups for repair.
- `--json`: print JSON output.

Configuration (in `plugins.entries.memory-core.config.memoryRollups`):

- `enabled`: whether deterministic rollups are active.
- `outputDir`: destination directory for rollups (defaults to `memory/session-rollups`).
- `maxMessages`: number of recent messages to summarize per transcript (default `80`).
- `maxSummaryChars`: hard character limit for generated rollup markdown.
- `redactSecrets`: remove likely sensitive values from generated summary text while preserving verification identifiers.

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "memoryRollups": {
            "enabled": true,
            "outputDir": "memory/session-rollups",
            "maxMessages": 80,
            "maxSummaryChars": 1800,
            "redactSecrets": true
          }
        }
      }
    }
  }
}
```

`memory status` also reports:

- `Session rollups`: enabled/disabled.
- `Rollup coverage`: discovered/generated/pending/stale/orphaned/evidence percentage.
- `Rollup health` warning when stale ratio exceeds threshold.
- `Memory Curator guard`: non-secret counts for allowed, denied, approval-required,
  approval-requested, pending-approval, allow-once, approval-denied, expired, replay-blocked,
  redacted, private-blocked, stale, and contradictory durable-memory decisions. The same status
  includes UTC daily `trendBuckets` for recent guard activity; trend buckets contain dates and
  counts only, never memory snippets, approval IDs, source paths, or redacted previews. Guard
  `alerts` are also count-only: by default they warn at denied >= 3, stale recalls >= 5, expired
  approvals >= 3, pending approvals >= 3, and mark private blocks, contradictions, or replay
  blocks as critical at >= 1.
- `Memory Curator audit`: `openclaw memory audit --json` exports the same guard health as a
  non-secret operational report suitable for review packets.

## Memory Curator operator runbook

Use this flow when a durable memory promotion needs review:

1. Request approval without writing:

   ```bash
   openclaw memory promote --apply --request-approval --json
   ```

2. Review the pending approval in the Control UI Dreams tab or your approval channel. Confirm
   the metadata only: operation, sensitivity class, confidence, freshness, evidence status, and
   count-only reasons.
3. If safe, choose **Allow once**. If unsafe or unclear, choose **Deny**.
4. Resume only with an explicit CLI apply:

   ```bash
   openclaw memory promote --apply --approval-id plugin:example-approval --json
   ```

Rules:

- UI approval never writes durable memory. It only resolves the approval.
- Durable writes require the explicit `--approval-id` CLI resume command.
- Denied, expired, mismatched, or replayed approval IDs write nothing.
- Never copy raw private memory, credentials, cookies, tokens, SSH keys, wallet data, source
  snippets, or personal/payment identifiers into approvals, exports, logs, docs, or tickets.

Operational responses:

- Repeated denies: run `openclaw memory audit --days 30 --json`, inspect denied counts and alerts,
  then escalate to the Control Director with the audit report only.
- Private-memory blocks: treat as privacy-critical. Do not retry promotion with the same content;
  ask the Memory & Knowledge Curator to produce a safer private-scope summary.
- Contradictions: stop promotion, collect the audit report, and ask the Judge to review source
  confidence before any durable write.
- Stale recall spikes: re-run memory status and index checks, then verify whether the source daily
  notes are current before approving promotion.
- Replay blocks: assume the approval ID was already consumed or mismatched. Request a new approval
  instead of reusing the blocked ID.
- Approval expirations: request a fresh approval only after confirming the candidate still matches
  the current source content.

Architecture notes:

- `memory-core` remains the authoritative active memory plugin and durable recall store.
- Raw session transcripts stay in the session store; rollups are compact local recall artifacts generated from those transcripts.
- Rollup generation and indexing do not depend on companion knowledge layers such as `memory-wiki`.
- Companion layers should treat rollups as source artifacts and only promote reviewed, high-signal content into curated pages.

`memory rem-harness`:

Preview REM reflections, candidate truths, and deep promotion output without writing anything.

```bash
openclaw memory rem-harness [--agent <id>] [--include-promoted] [--json]
```

- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted deep candidates.
- `--json`: print JSON output.

## Dreaming

Dreaming is the background memory consolidation system with three cooperative
phases: **light** (sort/stage short-term material), **deep** (promote durable
facts into `MEMORY.md`), and **REM** (reflect and surface themes).

- Enable with `plugins.entries.memory-core.config.dreaming.enabled: true`.
- Toggle from chat with `/dreaming on|off` (or inspect with `/dreaming status`).
- Dreaming runs on one managed sweep schedule (`dreaming.frequency`) and executes phases in order: light, REM, deep.
- Only the deep phase writes durable memory to `MEMORY.md`.
- Human-readable phase output and diary entries are written to `DREAMS.md` (or existing `dreams.md`), with optional per-phase reports in `memory/dreaming/<phase>/YYYY-MM-DD.md`.
- Ranking uses weighted signals: recall frequency, retrieval relevance, query diversity, temporal recency, cross-day consolidation, and derived concept richness.
- Promotion re-reads the live daily note before writing to `MEMORY.md`, so edited or deleted short-term snippets do not get promoted from stale recall-store snapshots.
- Scheduled and manual `memory promote` runs share the same deep phase defaults unless you pass CLI threshold overrides.
- Automatic runs fan out across configured memory workspaces.

Default scheduling:

- **Sweep cadence**: `dreaming.frequency = 0 3 * * *`
- **Deep thresholds**: `minScore=0.8`, `minRecallCount=3`, `minUniqueQueries=3`, `recencyHalfLifeDays=14`, `maxAgeDays=30`

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Notes:

- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- If effectively active memory remote API key fields are configured as SecretRefs, the command resolves those values from the active gateway snapshot. If gateway is unavailable, the command fails fast.
- Gateway version skew note: this command path requires a gateway that supports `secrets.resolve`; older gateways return an unknown-method error.
- Tune scheduled sweep cadence with `dreaming.frequency`. Deep promotion policy is otherwise internal; use CLI flags on `memory promote` when you need one-off manual overrides.
- `memory rem-harness --path <file-or-dir> --grounded` previews grounded `What Happened`, `Reflections`, and `Possible Lasting Updates` from historical daily notes without writing anything.
- `memory rem-backfill --path <file-or-dir>` writes reversible grounded diary entries into `DREAMS.md` for UI review.
- `memory rem-backfill --path <file-or-dir> --stage-short-term` also seeds grounded durable candidates into the live short-term promotion store so the normal deep phase can rank them.
- `memory rem-backfill --rollback` removes previously written grounded diary entries, and `memory rem-backfill --rollback-short-term` removes previously staged grounded short-term candidates.
- See [Dreaming](/concepts/dreaming) for full phase descriptions and configuration reference.

## Related

- [CLI reference](/cli)
- [Memory overview](/concepts/memory)
