---
summary: "CLI reference for `openclaw skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `openclaw skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [ClawHub](/tools/clawhub)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills list --agent planner
openclaw skills info <name>
openclaw skills info <name> --agent planner
openclaw skills check
openclaw skills check --agent planner
```

Use `--agent <id>` to inspect the skills visible to a specific configured agent workspace instead of the default agent.
