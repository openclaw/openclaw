# Skill ownership and installation

Keep OpenClaw contributor workflows here: development, debugging, testing, and
the repository-specific parts of review and release validation.

| Workflow | Canonical source |
| --- | --- |
| Portable review, handoff, transcripts, and remote validation | [openclaw/agent-skills](https://github.com/openclaw/agent-skills) |
| Team deployment, private release operations, and organization administration | [openclaw/maintainers](https://github.com/openclaw/maintainers) |
| OpenClaw product and contributor workflows | This directory |

## Maintainer setup

Before a maintainer operation, ensure the required skills are installed and read
their full instructions. From a reviewed `openclaw/agent-skills` checkout, install
the shared workflows with its native installer:

```sh
python3 scripts/install-skills autoreview crabbox
```

For Team updates, install `update-team-server` from `openclaw/maintainers` using
its [installation guide](https://github.com/openclaw/maintainers/blob/main/.agents/skills/AGENTS.md#install-before-use).
Use the agent's configured skill directory and a durable source checkout.
Preserve existing installations and report conflicts or missing access.
Installation grants no authority to deploy, publish, or change credentials.
Missing private maintainer skills do not block ordinary contributor work.

## Keep discovery and instructions small

Descriptions identify the task. `SKILL.md` contains shared decisions and routes
to task-specific references. Read each selected reference in full, without
loading unrelated modes. Keep each procedure in one place.

Edit shared implementations in their owning repository. Reuse installed skills
instead of copying their scripts or tests here. Keep necessary product fixtures
and assets with their owner; generated output and local caches are not skills.
