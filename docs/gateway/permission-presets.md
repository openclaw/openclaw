---
summary: "Autonomy presets with explicit risk boundaries"
title: "Permission presets"
---

# Permission presets

Permission presets make autonomy explicit and reduce ambiguity in day-to-day operation.

## SAFE

Best for new deployments and sensitive contexts.

### Allowed
- Read-only analysis
- Drafting docs/plans
- Non-destructive local inspection

### Approval required
- External/public messaging
- Destructive actions
- Security/config changes

## BALANCED (recommended default)

Best for routine operations.

### Allowed
- SAFE actions
- Routine local edits/commands
- Monitoring and reporting loops

### Approval required
- Public/external sends
- Credential/secret changes
- High-impact automation changes

## POWER

Best for advanced operators with active oversight.

### Allowed
- BALANCED actions
- Multi-step autonomous execution
- Worker orchestration flows

### Still gated
- External/public actions
- Broad destructive operations
- Security posture changes

## Selecting a preset

Start with **BALANCED**. Move to **POWER** only when:
- scope is explicit,
- rollback path exists,
- logging/audit is enabled,
- escalation path is defined.

## Oversight baseline (all presets)

- Approval for external sends
- Approval for destructive operations
- Log major actions
- Prefer reversible changes first

## Example policy block

```md
Current preset: BALANCED
Auto-allowed: local analysis, drafting, routine edits, monitoring loops
Approval-required: external messaging, credential changes, destructive ops
Escalation: notify owner before irreversible action
```
