---
name: {{HOOK_NAME}}
description: "{{DESCRIPTION}}"
metadata:
  dna:
    emoji: "{{EMOJI}}"
    events: ["{{EVENT}}"]  # agent:bootstrap, command:new, command:reset, etc.
---

# {{Hook Title}}

## What It Does

{{Describe what this hook does in 2-3 sentences}}

## Events

| Event | When It Fires |
|-------|---------------|
| `{{EVENT}}` | {{Description}} |

## Behavior

{{Describe the hook's behavior in detail}}

### Conditions

The hook activates when:
- {{Condition 1}}
- {{Condition 2}}

### Actions

When activated, the hook:
1. {{Action 1}}
2. {{Action 2}}

## Configuration

{{If the hook reads config, document it}}

No configuration required.

## Requirements

- DNA with hooks enabled
- {{Any other requirements}}

## Related

- {{Related hook or doc}}

---

*Created: {{DATE}}*
