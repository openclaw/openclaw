---
children_hash: 5fe7855fe45e5cfb309b675ab08535e9a6e91eebe7d5f885bf09c0bb1459433c
compression_ratio: 0.47101449275362317
condensation_order: 3
covers: [project/_index.md]
covers_token_total: 276
summary_level: d3
token_count: 130
type: summary
---

# Health Audit 2026-04-08

Single audit session with 7 operational fixes across 5 areas. **OpenRouter guardrail compliance** drove model routing changes.

**Key Fixes:**

- **Model routing:** Prefix `openrouter/` now required; brv model switched to `minimax/minimax-m2.7`
- **Compaction:** Threshold raised 20x (4000→80000)
- **Cron jobs:** 4 delivery targets corrected
- **Plugin config:** Allow limit set to 10 plugins
- **Cleanup:** `moltbot.json` archived

**Details:** `project/operations/health_audit_2026_04_08.md`
