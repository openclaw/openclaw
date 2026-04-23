---
name: answer_from_runbooks_first
description: Search runbooks before falling back to code or config inspection.
metadata:
  {
    "openclaw":
      { "emoji": "📚", "requires": { "config": ["plugins.entries.runbook-memory.enabled"] } },
  }
---

# Answer From Runbooks First

You must use this before opening source code or editing config for docs, runbooks, operational-memory, or local OpenClaw configuration tasks.

## Procedure

1. extract hard tokens and scope
2. search runbooks
3. inspect the best runbook cards
4. inspect the best chunks if needed
5. answer or act from docs when confidence is adequate
6. fall back to code inspection only when docs are insufficient

## Confidence

High confidence needs:

- active lifecycle
- scope match
- recent validation
- exact token match when relevant
