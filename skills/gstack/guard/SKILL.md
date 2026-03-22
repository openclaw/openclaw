---
name: guard
description: |
  Maximum safety mode — combines careful (destructive command warnings) with
  freeze (edit scope restriction). Use when working with production systems
  or making sensitive changes.
---

# Guard — Maximum Safety Mode

Activates both [careful](../careful/SKILL.md) and [freeze](../freeze/SKILL.md) simultaneously. Maximum safety for production work.

**Related skills:** [careful](../careful/SKILL.md) | [freeze](../freeze/SKILL.md) | [unfreeze](../unfreeze/SKILL.md)

---

## Activation

When the user says "guard mode" or "be very careful":

1. Activate [careful](../careful/SKILL.md) — warn before destructive commands
2. Activate [freeze](../freeze/SKILL.md) — restrict edits to specified directory
3. Display status:

```
🛡️  GUARD MODE ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Destructive command warnings: ON
Edit scope: [directory] (or "ask user to specify")
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Deactivation

Use [unfreeze](../unfreeze/SKILL.md) to remove both restrictions.
