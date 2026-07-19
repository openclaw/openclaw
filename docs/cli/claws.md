---
summary: "Validate, preview, and add experimental Claw agent packages"
read_when:
  - You want to validate a grouped Claw manifest
  - You want to preview or add one agent from a Claw
title: "Claws"
---

# `openclaw claws`

A Claw is a versioned setup for one new OpenClaw agent. It can describe the
agent configuration, workspace files, skills, plugins, MCP servers, and cron
jobs that agent needs. A Claw does not replace or modify an existing agent.

Claws are experimental. Their schema, command output, and lifecycle may change.
Enable the command surface explicitly:

```bash
export OPENCLAW_EXPERIMENTAL_CLAWS=1
```

The current CLI reads a local package directory or grouped JSON manifest.
Publishing, searching, and installing whole Claws through ClawHub are a
separate registry track and are not part of this command surface yet.

## Create a grouped manifest

Start with a version 1 JSON manifest:

```json
{
  "schemaVersion": 1,
  "agent": {
    "id": "incident-triage",
    "name": "Incident triage",
    "tools": { "deny": ["exec"] }
  },
  "workspace": { "bootstrapFiles": {} },
  "packages": [],
  "mcpServers": {},
  "cronJobs": []
}
```

Package and workspace paths must remain inside the package root. Manifests are
limited to 1 MiB, package metadata to 256 KiB, and workspace sources enforce
separate per-file and aggregate limits. Workspace sources also reject symlinked
parents.

## Inspect and preview

Validate the source without planning local changes:

```bash
openclaw claws inspect ./incident-triage.claw.json
```

Preview all proposed lifecycle actions:

```bash
openclaw claws add ./incident-triage.claw.json --dry-run --json
```

The plan reports the derived agent and workspace, every proposed action,
prerequisites, blockers, distinct capability escalations, and a `planIntegrity`
digest. Capability records show the exact package, MCP, scheduled-work, sandbox,
tool, or heartbeat effect. Review the plan before creating the agent:

```bash
openclaw claws add ./incident-triage.claw.json \
  --yes \
  --plan-integrity <SHA256_FROM_DRY_RUN>
```

`--yes` alone is insufficient. OpenClaw rebuilds the plan and rejects consent
when the source, destination, or live configuration changed after preview. Use
`--agent-id` or `--workspace` during both preview and apply when package
defaults collide with local state.

At this stage, adding a Claw creates the new agent and workspace configuration
and records installation provenance. Later Claws stages add managed workspace
files and other declared resources.

## Command reference

| Command                  | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `claws inspect <source>` | Validate a package directory or JSON manifest. |
| `claws add <source>`     | Preview or create one new agent and workspace. |

Use `--json` for experimental machine-readable output.

## See also

- [Agents](/cli/agents)
- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
