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
  minimal recommended plugin set or maximum convenience.
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

With the stock `BOOTSTRAP.md`, a workspace counts as configured once `SOUL.md`,
`IDENTITY.md`, or `USER.md` has diverged from its starter template, or a `memory/`
folder exists. Custom `BOOTSTRAP.md` instructions stay pending until the file is
removed after setup completes; preconfigured profiles and skills do not complete
that onboarding.
When OpenClaw has recorded a file as generated, an unchanged copy of that starter
file keeps onboarding pending even if an update changes the bundled template.

<Note>
`BOOTSTRAP.md` covers the full identity conversation. See its contents at
[BOOTSTRAP.md template](/reference/templates/BOOTSTRAP).
</Note>

## Conversation starters

Add optional YAML frontmatter to a workspace's `BOOTSTRAP.md` to offer
setup-specific prompts on the Control UI's new-chat screen:

```markdown
---
conversationStarters:
  - Connect my calendar
  - Set up a repository
  - Walk me through setup
---

# First-run setup

Help the user connect their tools and choose their preferences.
```

The existing agent `description` setting supplies the welcome description.
Starters are plain-text prompts in author order. Opening the screen sends
nothing; clicking a starter submits that text as a normal user message.
Custom starters remain available beside recent chats and on phones. Incognito
keeps authored starters without showing recent chats; model setup and terminal
targets keep their own guidance.

Missing, empty, malformed, or unreadable starter metadata keeps the default
suggestions. Entries must be nonempty strings; surrounding whitespace is trimmed.
The Markdown instructions and native seed-once lifecycle are unchanged.
When setup removes `BOOTSTRAP.md`, its starters disappear on the next refreshed
agent list. Starters are not copied into agent configuration or retained after
bootstrap completion.

[Templates](/cli/templates) can ship the same frontmatter in their package-root
`BOOTSTRAP.md`; Add preserves it with the first-run instructions.

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
