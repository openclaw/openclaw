---
name: unfreeze
description: |
  Remove the freeze/guard edit boundary. Restores unrestricted file editing.
---

# Unfreeze — Remove Edit Restrictions

Removes the edit scope restriction set by [freeze](../freeze/SKILL.md) or [guard](../guard/SKILL.md).

**Related skills:** [freeze](../freeze/SKILL.md) | [guard](../guard/SKILL.md) | [careful](../careful/SKILL.md)

---

## Behavior

1. Clear the freeze boundary
2. If guard mode was active, also deactivate careful mode
3. Confirm:

```
🔓 UNFROZEN — edits unrestricted. Guard mode OFF.
```
