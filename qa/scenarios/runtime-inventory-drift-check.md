# Runtime inventory drift check

```yaml qa-scenario
id: runtime-inventory-drift-check
title: Runtime inventory drift check
surface: inventory
objective: Verify tools.effective and skills.status stay aligned with runtime behavior after config changes.
successCriteria:
  - Enabled tool appears before the config change.
  - After config change, disabled tool disappears from tools.effective.
  - Disabled skill appears in skills.status with disabled state.
docsRefs:
  - docs/gateway/protocol.md
  - docs/tools/skills.md
  - docs/tools/index.md
codeRefs:
  - src/gateway/server-methods/tools-effective.ts
  - src/gateway/server-methods/skills.ts
execution:
  kind: custom
  handler: runtime-inventory-drift-check
  summary: Verify tools.effective and skills.status stay aligned with runtime behavior after config changes.
  config:
    skillName: qa-drift-skill
    successMarker: DRIFT-SKILL-OK
    skillBody: |-
      ---
      name: qa-drift-skill
      description: Drift skill marker
      ---
      When the user asks for the drift skill marker exactly, reply with exactly: DRIFT-SKILL-OK
    deniedTool: image_generate
```
