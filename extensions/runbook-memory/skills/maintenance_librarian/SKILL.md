---
name: maintenance_librarian
description: Keep the runbook memory subsystem healthy on a schedule.
metadata:
  {
    "openclaw":
      { "emoji": "🧹", "requires": { "config": ["plugins.entries.runbook-memory.enabled"] } },
  }
---

# Maintenance Librarian

Use this for recurring maintenance on the runbook memory layer.

## Nightly

1. reindex changed docs
2. regenerate cards and summaries
3. update stale-doc review queue
4. detect duplicates
5. write a health report

## Weekly

1. run retrieval evals
2. compare against baseline
3. report low-confidence or poorly rated docs

## Safety

- never delete canonical docs automatically
- deprecate instead of hard delete
- log every automated metadata change
