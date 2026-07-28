---
summary: "Optional inventory records for workspace-local integrations"
read_when:
  - You maintain a workspace with local integrations or bridges
  - You need to distinguish capability inventory from skills and plugins
title: "Workspace capability inventory"
sidebarTitle: "Workspace capability inventory"
---

`capabilities/*.md` is an optional, advanced convention for concise inventory
records about integrations intentionally exposed to one agent workspace. A
record identifies what exists and points to its responsible owner and
authoritative instructions; it is not an instruction package or runtime
extension.

Use this pattern only for advanced local setups that need a small inventory of
bridges, devices, services, or other workspace-specific entry points. Put
repeatable agent instructions in a [workspace skill](/tools/skills), add runtime
capabilities through a [plugin](/tools/plugin), and use [ClawHub](/clawhub) for
shared distribution and discovery.

<Warning>
Inventory records are not discovered or loaded automatically, do not grant tool
access, and do not change runtime permissions. The Gateway remains authoritative
for access, auth, routing, and tool policy. The linked workspace skill or plugin
documentation remains authoritative for operating instructions.
</Warning>

## Location

Keep a concise inventory under:

```text
capabilities/
  index.md
  windows-bridge.md
```

Start with `capabilities/index.md`. Add a separate file only when one record's
metadata would make the index difficult to scan. Use stable, lowercase
filenames such as `windows-bridge.md`.

## Inventory record format

Keep records short and point to the existing source of truth:

```markdown
# Capability name

- Status: active, unavailable, or deprecated
- Scope: workspace, project, host, or external service
- Use for: one-sentence capability summary
- Owner: plugin, service, or operator responsible for availability
- Canonical instructions: link to workspace skill or plugin documentation
- Entry point: tool, plugin, queue, command, or file name
- Availability check: read-only status check
- Last verified: date and environment
- Safety: approval or data boundary summary
```

Keep records to metadata and links. Do not copy setup steps, command sequences,
configuration, authentication details, fallback procedures, or safety policy
into them.

The canonical instructions field is required. If there is no authoritative
workspace skill or plugin documentation to link, create that source before
advertising the capability to agents.

## What belongs here

Good candidates:

- A host-specific bridge whose operating instructions live in a workspace skill.
- A local service exposed by a plugin but not useful outside this workspace.
- A device or queue that needs a visible status and owner pointer.
- A temporary compatibility entry that names its removal condition.

Do not use inventory records for:

- Step-by-step agent procedures or reusable prompts. Put those in a
  [workspace skill](/tools/skills).
- Tools, auth flows, lifecycle hooks, providers, or other runtime behavior. Put
  those in a [plugin](/tools/plugin).
- Reusable community integrations or skills. Publish and discover those through
  [ClawHub](/clawhub).
- Facts, preferences, or session observations. Put those in
  [memory](/concepts/memory).
- Persona rules. Put those in `AGENTS.md` or `SOUL.md`.
- Secrets, tokens, refresh credentials, private OAuth state, or executable
  command sequences.

Do not duplicate a skill or plugin's instructions in a capability record. If
the owner already provides an inventory or discovery surface, link to it or
remove the local record.

## Discovery behavior

Capability records are not part of the fixed bootstrap file set. The standard
bootstrap files are documented in
[System prompt](/concepts/system-prompt#workspace-bootstrap-injection), and
extra bootstrap injection accepts recognized bootstrap basenames.

When a workspace intentionally exposes its local inventory, link the concise
`capabilities/index.md` from `TOOLS.md`. The index should only identify the
available surface, its owner, and its canonical instructions; the agent must
read the linked skill or plugin documentation before acting.

Do not inject every record by default or add a listener, session store, auth
layer, or shadow tool router for discovery.

## Agent guidance

An agent can consult an intentionally linked inventory before concluding that
a local task is unsupported. Finding a record is only a discovery step: verify
the stated owner and availability, then follow the linked instructions and
normal approval rules. If the owner or instructions are missing, stale, or
ambiguous, do not act from the record; verify through the runtime surface or ask
the user for direction.
