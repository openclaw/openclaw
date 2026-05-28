---
summary: "Defines the minimum closed-loop runtime checkpoints for OpenClaw autonomous task execution."
read_when:
  - You are running autonomous task loops and need preflight validation
  - You are preparing inventory checks before apply/promote actions
title: "Autonomous Runtime"
---

# Autonomous Runtime

This runtime contract keeps autonomous work in a safe closed loop:

1. **Preflight**: verify required directories, docs, and plugin manifests.
2. **Plan**: select exactly one smallest safe task.
3. **Apply**: execute bounded changes only inside the current repo.
4. **Validate**: run inventory and required checks.
5. **Report**: emit pass/fail, risks, rollback path, and next safe task.

## Required commands

```bash
pnpm autonomous:inventory:check
pnpm governance:r8:check
pnpm blackbox:check
```

Use this check before and after autonomous changes to prevent drift in runtime prerequisites.

Specification traceability:

- Specification traceability: `enforces decode-budget fail-closed policy for unresolved encoded octets` (`extensions/automation/src/register.test.ts`) -> `hasPathTraversalAttempt` (`extensions/automation/src/register.ts`) -> [WebApp encoded-path guard matrix](./module-skill-inventory.md#webapp-encoded-path-guard-matrix) -> `(self-anchor)`.
