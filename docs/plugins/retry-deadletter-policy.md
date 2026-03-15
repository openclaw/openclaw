---
summary: "Plugin-scoped bounded retry and dead-letter policy to prevent silent task loss."
read_when:
  - You are implementing plugin retry behavior
  - You need dead-letter handling for failed plugin tasks
title: "Retry + Dead-letter Policy"
---

# Retry + Dead-letter Policy (v1)

Related: [Core retry policy](/concepts/retry)

## Retry
- Bounded retries only (no infinite loops)
- Explicit retry count + backoff

## Dead-letter
- Failed items after max retries move to dead-letter queue
- Must include failure reason + next operator action
