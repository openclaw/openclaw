---
summary: "Memory Audit reviews durable memory and stages human-approved add, edit, delete, and move recommendations."
read_when:
  - You want to review durable memory without letting the agent write directly
  - You want scheduled cleanup for stale or low-value memory
title: "Memory Audit"
---

# Memory Audit

Memory Audit is a separate memory quality pass from Dreaming.
Dreaming promotes short-term candidates into durable memory; Memory Audit reviews
durable memory after the fact and stages recommendations for a human to apply or
reject.

The audit agent can inspect durable memory surfaces:

- `MEMORY.md`
- `USER.md`
- `TOOLS.md`
- `shared-memory.md`

Recommendations are stored as pending records in `memory/audit/suggestions.jsonl`.
Staging a recommendation does **not** edit memory files. Durable writes happen
only when an operator applies a pending suggestion through the Gateway.

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

Enable Memory Audit in the `memory-core` plugin config:

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
`memory_audit_collect`, inspect durable surfaces, and call `memory_audit_stage`
for high-value recommendations. The prompt explicitly tells the agent not to edit
memory files directly.

## Relationship To Dreaming

Dreaming and Memory Audit are intentionally independent:

- Dreaming runs the promotion pipeline.
- Memory Audit reviews existing durable memory.
- Dreaming can write durable promotions during its deep phase.
- Memory Audit only stages recommendations until a human applies one.

Use Dreaming when you want automatic short-term-to-long-term consolidation. Use
Memory Audit when you want a review queue for cleanup, correction, and moving
facts to the right surface.

## Files

- Suggestions: `memory/audit/suggestions.jsonl`
- Optional reports: `memory/audit/reports/YYYY-MM-DD.md`

The suggestion log is append-only. The latest record for a suggestion id is the
current state, so apply/reject/conflict transitions are auditable.
