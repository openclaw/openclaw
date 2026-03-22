---
name: freeze
description: |
  Restrict file edits to one directory. Prevents accidental changes outside
  scope while debugging or working on a focused task.
  Use when you want to scope edits to a specific module or directory.
---

# Freeze — Scope Lock

Restrict all file edits to a single directory. Prevents accidental changes to unrelated code while debugging or making focused changes.

**Related skills:** [unfreeze](../unfreeze/SKILL.md) | [guard](../guard/SKILL.md) | [careful](../careful/SKILL.md) | [investigate](../investigate/SKILL.md)

---

## Activation

When the user says "freeze to [directory]" or when [investigate](../investigate/SKILL.md) auto-locks scope:

1. Record the allowed directory
2. Before every file edit, check if the target file is within the allowed directory
3. If outside: **block the edit** and explain why

---

## Behavior

```
🔒 FREEZE ACTIVE: edits restricted to src/auth/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Allowed
- Any file under the frozen directory
- Reading files anywhere (read-only is always allowed)

### Blocked
- Editing files outside the frozen directory
- Creating new files outside the frozen directory

### When Blocked

```
⛔ EDIT BLOCKED: src/api/handler.ts is outside the freeze boundary (src/auth/)
   Run /unfreeze to remove the restriction, or explain why this file needs to change.
```

---

## Use Cases

- **Debugging**: Lock to the buggy module to prevent scope creep
- **Focused refactoring**: Only touch the files you're refactoring
- **Code review fixes**: Only modify files in the PR

Use [unfreeze](../unfreeze/SKILL.md) to remove the restriction.
