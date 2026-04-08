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
    skillName: qa-visible-skill
    skillBody: |-
      ---
      name: qa-visible-skill
      description: Visible QA skill marker
      ---
      When the user asks for the visible skill marker exactly, or explicitly asks you to use qa-visible-skill, reply with exactly: VISIBLE-SKILL-OK
    prompt: "Use qa-visible-skill now. Reply exactly with the visible skill marker and nothing else."
    expectedContains: "VISIBLE-SKILL-OK"
```
