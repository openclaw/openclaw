# Skill visibility and invocation

```yaml qa-scenario
id: skill-visibility-invocation
title: Skill visibility and invocation
surface: skills
objective: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
successCriteria:
  - skills.status reports the seeded skill as visible and eligible.
  - The next agent turn reflects the skill instruction marker.
  - The result stays scoped to the active QA workspace skill.
docsRefs:
  - docs/tools/skills.md
  - docs/gateway/protocol.md
codeRefs:
  - src/agents/skills-status.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: skill-visibility-invocation
  summary: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
  config:
    prompt: "Visible skill marker: give me the visible skill marker exactly."
    expectedContains: "VISIBLE-SKILL-OK"
```
