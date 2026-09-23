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

- Seeds `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, and `BOOTSTRAP.md`. Environment-specific tool notes belong in the `## Tools` section of `AGENTS.md`.
- Has the agent follow a short birth sequence: it asks what you want
  to call it, shares one short soul/vibe line, generates four avatar options
  when `image_generate` is available, asks whether you want the
  minimal recommended plugin set or maximum convenience, and closes with one
  short safety note about the access it runs with.
- Persists the agreed identity twice: into `IDENTITY.md` and `SOUL.md` (what the
  agent reads about itself) and via `openclaw agents set-identity` (what channels
  and the UI display).
- Presents four generated avatars in a numbered 2×2 choice sheet for you to
  choose or skip, using the configured image-generation model or an available
  provider such as OpenAI. The selected portrait is cropped from the sheet,
  saved under the workspace's `avatars/` directory, and synced into identity.
  Identity files are saved after this choice so an
  asynchronous generation does not end hatching early. If generation is
  unavailable or fails, hatching continues with the emoji.
- Reads app recommendations already stored during onboarding without rescanning.
  Official plugins use `openclaw plugins install <id>`; third-party ClawHub
  skills remain explicit opt-ins. After the choice is handled, the agent
  acknowledges the stored offer so it never asks again.
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
