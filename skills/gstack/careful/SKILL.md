---
name: careful
description: |
  Safety guardrails — warns before destructive commands. Activate by saying
  "be careful" or when working with production systems.
  Warns on: rm -rf, DROP TABLE, force-push, git reset --hard, DELETE without WHERE.
---

# Careful — Destructive Command Guardrails

When active, warn before any potentially destructive operation. The user must explicitly confirm before proceeding.

**Related skills:** [freeze](../freeze/SKILL.md) | [guard](../guard/SKILL.md) | [unfreeze](../unfreeze/SKILL.md)

---

## Destructive Commands to Guard

### File System
- `rm -rf` — Recursive force delete
- `rm -r` on important directories
- Any operation that removes entire directories

### Database
- `DROP TABLE` / `DROP DATABASE`
- `DELETE` without `WHERE` clause
- `TRUNCATE TABLE`
- `ALTER TABLE DROP COLUMN`

### Git
- `git push --force` / `git push -f` (especially to main/master)
- `git reset --hard`
- `git clean -fd`
- `git branch -D` on shared branches

### Infrastructure
- Destroying cloud resources (terraform destroy, kubectl delete)
- Modifying production environment variables
- Stopping production services

---

## Warning Format

When a destructive command is about to execute:

```
⚠️  DESTRUCTIVE COMMAND DETECTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Command:   [the command]
Risk:      [what could go wrong]
Reversible: YES / NO / PARTIAL

Proceed? (The user must explicitly confirm)
```

---

## Rules

- **Never execute a destructive command without explicit user confirmation**
- **Always explain what could go wrong** — don't just say "are you sure?"
- **Suggest safer alternatives** when they exist (e.g., `git push --force-with-lease` instead of `--force`)
- **The user can always override** — these are guardrails, not handcuffs

Combine with [freeze](../freeze/SKILL.md) for maximum safety, or use [guard](../guard/SKILL.md) for both at once.
