# Skill install hot availability

```yaml qa-scenario
id: skill-install-hot-availability
title: Skill install hot availability
surface: skills
objective: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
successCriteria:
  - Skill is absent before install.
  - skills.status reports it after install without a restart.
  - The next agent turn reflects the new skill marker.
docsRefs:
  - docs/tools/skills.md
  - docs/gateway/configuration.md
codeRefs:
  - src/agents/skills-status.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: skill-install-hot-availability
  summary: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
  config:
    skillName: qa-hot-install-skill
    skillBody: |-
      ---
      name: qa-hot-install-skill
      description: Hot install QA marker
      ---
      When the user asks for the hot install marker exactly, reply with exactly: HOT-INSTALL-OK
    prompt: "Hot install marker: give me the hot install marker exactly."
    expectedContains: "HOT-INSTALL-OK"
```
