---
children_hash: 53d067a7eda22d08fc78146c25e7957b58c1cd3b184d43638a900cda6f04c5b7
compression_ratio: 0.6158357771260997
condensation_order: 2
covers: [context.md, operations/_index.md]
covers_token_total: 341
summary_level: d2
token_count: 210
type: summary
---

# Project Operations

Operational knowledge domain covering health audits, configuration changes, remediation actions, and operational procedures.

## Health Audit 2026-04-08

Single-session audit with 7 fixes addressing model routing, compaction, cron jobs, plugin config, and brv model settings.

**Key Changes:**

| Area          | Change                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Model routing | Requires `openrouter/` prefix; switched brv from `openai/gpt-4.1-mini` to `minimax/minimax-m2.7` |
| Compaction    | Threshold increased 20x (4000→80000)                                                             |
| Cron targets  | 4 delivery targets corrected                                                                     |
| Plugin config | `plugins.allow` set to 10 plugins                                                                |
| Agent install | `acpx 0.5.1`                                                                                     |
| Cleanup       | `moltbot.json` archived                                                                          |

**Dependency:** OpenRouter guardrail compliance drove model routing changes.

**Drill-down:** `project/operations/health_audit_2026_04_08.md`
