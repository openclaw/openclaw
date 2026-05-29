---
summary: "Memory Audit reviews durable memory and stages human-approved add, edit, delete, and move recommendations."
read_when:
  - You want to review durable memory without letting the agent write directly
  - You want scheduled cleanup for stale or low-value memory
title: "Memory Audit"
---

# Memory Audit

Memory Audit is a human-reviewed alternative for memory quality work.
Dreaming promotes short-term candidates into durable memory automatically;
Memory Audit uses an audit agent to inspect memory and session evidence, stage
recommendations, and leave the final apply or reject decision to a human.

The audit agent can inspect writable target surfaces:

- `AGENTS.md`
- `MEMORY.md`
- `USER.md`
- `TOOLS.md`
- `shared-memory.md`

It also inspects read-only evidence sources:

- recent daily memory files under `memory/*.md`
- recent session transcript logs

Recommendations are stored as pending records in `memory/audit/suggestions.jsonl`.
Staging a recommendation does **not** edit memory files. Daily memory files and
session logs are source evidence only; applying a recommendation can promote
facts from them into the writable targets above.

## Actions

Memory Audit supports four recommendation actions:

- `add`: append a durable memory block to a target surface
- `edit`: replace an existing source range after verifying it has not changed
- `delete`: remove an existing source range after verifying it has not changed
- `move`: remove a source range and append it to another target surface

For `edit`, `delete`, and `move`, OpenClaw stores the source line range and a
content hash. If the source changed after the recommendation was staged, applying
the suggestion marks it as `conflict` instead of writing over the newer file.

## Scheduling

Enable Memory Audit from the dashboard under **Audit > Settings**. The settings
tab controls:

- whether audit is enabled
- the audit agent, session target, model, and timezone
- daily and weekly schedule times plus raw cron expressions
- whether reports are delivered to a channel, account, thread, or webhook

The same settings can also be written directly in the `memory-core` plugin
config:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "memoryAudit": {
            "enabled": true,
            "daily": {
              "enabled": true,
              "cron": "10 6 * * *"
            },
            "weekly": {
              "enabled": true,
              "cron": "0 21 * * 0"
            }
          }
        }
      }
    }
  }
}
```

Defaults:

- Daily audit: `10 6 * * *`
- Weekly audit: `0 21 * * 0`
- Session target: `session:memory-audit`

The managed cron jobs ask the configured audit agent to run
`memory_audit_collect`, inspect writable targets plus daily/session evidence,
and call `memory_audit_stage` for high-value recommendations. The prompt
explicitly tells the agent not to edit memory files directly.

The session target controls where the audit run happens. Report delivery is
separate: `delivery.mode` can be `none`, `announce`, or `webhook`. Dashboard
dropdowns suggest real agents, sessions, configured models, channels, and
accounts from the connected Gateway.

## Relationship To Dreaming

Dreaming and Memory Audit are intentionally independent:

- Dreaming runs the promotion pipeline.
- Memory Audit reviews existing durable memory plus daily and session evidence.
- Dreaming can write durable promotions during its deep phase.
- Memory Audit only stages recommendations until a human applies one.

Use Dreaming when you want automatic short-term-to-long-term consolidation. Use
Memory Audit when you want a review queue that can clean up bad durable memory
and promote useful facts from daily notes or session logs into the right target.

## Files

- Suggestions: `memory/audit/suggestions.jsonl`
- Optional reports: `memory/audit/reports/YYYY-MM-DD.md`

The suggestion log is append-only. The latest record for a suggestion id is the
current state, so apply/reject/conflict transitions are auditable.
