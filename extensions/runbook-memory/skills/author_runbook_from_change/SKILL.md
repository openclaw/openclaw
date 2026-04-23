---
name: author_runbook_from_change
description: Create or update runbooks after an implemented change.
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "config": ["plugins.entries.runbook-memory.enabled"] } },
  }
---

# Author Runbook From Change

Use this when a feature, operational change, plugin change, or workaround has landed.

## Procedure

1. search for an existing runbook
2. update the existing doc if one fits
3. otherwise create a draft runbook
4. include purpose, use conditions, prerequisites, validation, and rollback
5. preserve provenance and stable `doc_id`
6. add related docs and scope metadata
7. trigger reindex
8. log what changed

## Constraints

- prefer updates over duplicates
- do not claim validation that did not happen
- mark uncertain content as review or draft
