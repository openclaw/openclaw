---
summary: "Workspace capability descriptors for local integrations and durable operating procedures"
read_when:
  - You need to document a workspace-local integration or bridge
  - You want agents to discover approved local capability paths before saying a task is unsupported
title: "Workspace capabilities"
sidebarTitle: "Workspace capabilities"
---

Workspace capabilities are optional Markdown descriptors for local integrations, bridge queues, task flows, ACP delegation paths, and durable operating procedures that belong to one agent workspace.

Use them when a capability is local to the workspace and should be discoverable across sessions, but does not need to become a plugin or a gateway feature yet.

<Warning>
Capability descriptors are documentation and operating guidance. They do not grant tool access, bypass approvals, change sandbox policy, or create new runtime permissions. The Gateway remains the source of truth for sessions, routing, auth, and tool policy.
</Warning>

## Location

Store descriptors under:

```text
capabilities/
  index.md
  graph-mail.md
  windows-bridge.md
```

`capabilities/index.md` is optional, but recommended. Keep it short: list each descriptor, the supported request types, and the safest first check.

## Descriptor format

Use one file per durable capability. Prefer stable, lowercase filenames such as `graph-mail.md` or `windows-bridge.md`.

```markdown
# Capability name

## Purpose

What this capability enables and when to use it.

## Supported requests

- Request type the capability can handle.
- Request type the capability cannot handle.

## Entry points

- Tools, commands, queues, task flows, ACP runtimes, or files involved.
- Read-only checks that are safe before taking action.

## Safety boundaries

- Required approvals.
- Secrets or data that must not be exposed.
- Operations that are destructive or externally visible.

## Verification

- How to confirm the capability is available.
- How to inspect status without changing runtime state.

## Fallback

- What to inspect before saying the task is unsupported.
- When to ask the user for help.
```

## What belongs here

Good candidates:

- A Windows bridge queue that lets a Linux-hosted agent request Windows-only work.
- A Microsoft Graph mail scan flow that already has auth and local wrapper scripts.
- A taskflow recipe for a long-running workspace job.
- An ACP delegation path to a configured local runtime.
- A local device, service, or script with specific approval boundaries.

Poor candidates:

- General persona rules. Put those in `AGENTS.md` or `SOUL.md`.
- Tool availability policy. Configure that through gateway and tool policy settings.
- Secrets, tokens, refresh credentials, or private OAuth state.
- A replacement router, proxy, or wrapper around the Gateway.

## Discovery behavior

Descriptors are not part of the fixed bootstrap file set by default. The standard bootstrap files are documented in [System prompt](/concepts/system-prompt#workspace-bootstrap-injection), and extra bootstrap injection currently accepts recognized bootstrap basenames.

To make capability descriptors visible, use one of these narrow approaches:

- Link the important descriptors from `TOOLS.md`.
- Keep a concise `capabilities/index.md` and reference it from `AGENTS.md` or `TOOLS.md`.
- Use an existing bootstrap or prompt hook when the workspace intentionally surfaces this context.

Do not add a separate listener, session store, auth layer, or shadow tool router just to discover capabilities.

## Agent guidance

When a user asks for work that sounds unavailable, agents should check the workspace capability index before answering that the task is impossible. A descriptor can point to the right bridge, taskflow, ACP runtime, or manual fallback without changing the runtime security model.

If the descriptor says an action is externally visible, destructive, or changes OpenClaw runtime state, follow the normal approval and safety rules before acting.
