---
summary: "CLI reference for `smart-agent-neo skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `smart-agent-neo skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- NeoHub installs: [NeoHub](/tools/neohub)

## Commands

```bash
smart-agent-neo skills list
smart-agent-neo skills list --eligible
smart-agent-neo skills info <name>
smart-agent-neo skills check
```
