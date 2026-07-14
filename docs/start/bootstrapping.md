---
summary: "Agent bootstrapping ritual that seeds the workspace and identity files"
read_when:
  - Understanding what happens on the first agent run
  - Explaining where bootstrapping files live
  - Debugging onboarding identity setup
title: "Agent bootstrapping"
sidebarTitle: "Bootstrapping"
---

Bootstrapping is the first-run ritual that seeds a new agent workspace and
walks the agent through picking an identity. It runs once, right after
onboarding, on the agent's first real turn.

## What happens

On the first run against a brand-new workspace (default `~/.openclaw/workspace`),
OpenClaw:

- Seeds `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`.
- Has the agent follow `BOOTSTRAP.md`: a free-form conversation (not a fixed Q&A form) to settle on a name, personality, and vibe.
- Writes what it learns into `IDENTITY.md`, `USER.md`, and `SOUL.md`.
- Deletes `BOOTSTRAP.md` once the workspace looks configured, so the ritual only runs once.

A workspace counts as configured once `SOUL.md`, `IDENTITY.md`, or `USER.md` has
diverged from its starter template, or a `memory/` folder exists.

<Note>
`BOOTSTRAP.md` covers the full identity conversation. See its contents at
[BOOTSTRAP.md template](/reference/templates/BOOTSTRAP).
</Note>

## Embedded and local model runs

For embedded or local-model runs, OpenClaw keeps `BOOTSTRAP.md` out of the
privileged system context. On the primary interactive first run it still
passes the file contents through the user prompt, so models that don't
reliably call the `read` tool can still complete the ritual. If the current
run cannot safely access the workspace, the agent gets a short limited-bootstrap
note instead of a generic greeting.

## Skipping bootstrapping

To skip this on a pre-seeded workspace, run:

```bash
openclaw onboard --skip-bootstrap
```

## Where it runs

Bootstrapping always runs on the gateway host. If the macOS app connects to a
remote Gateway, the workspace and its bootstrap files live on that remote
machine, not on the Mac.

<Note>
When the Gateway runs on another machine, edit workspace files on the gateway
host (for example, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Related docs

- macOS app onboarding: [Onboarding](/start/onboarding)
- Workspace layout: [Agent workspace](/concepts/agent-workspace)
- Template contents: [BOOTSTRAP.md template](/reference/templates/BOOTSTRAP)
