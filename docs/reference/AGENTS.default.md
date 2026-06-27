---
summary: "Default OpenClaw agent instructions and skills roster for the personal assistant setup"
title: "Default AGENTS.md"
read_when:
  - Starting a new OpenClaw agent session
  - Enabling or auditing default skills
---

## First run (recommended)

OpenClaw uses a dedicated workspace directory for the agent. Default: `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).

1. Create the workspace (if it doesn't already exist):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copy the default workspace templates into the workspace:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optional: if you want the personal assistant skill roster, replace AGENTS.md with this file:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optional: choose a different workspace by setting `agents.defaults.workspace` (supports `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Safety defaults

- Don't dump directories or secrets into chat.
- Don't run destructive commands unless explicitly asked.
- Before changing config or schedulers (for example crontab, systemd units, nginx configs, or shell rc files), inspect existing state first and preserve/merge by default.
- Don't send partial/streaming replies to external messaging surfaces (only final replies).

## Existing solutions preflight

Before proposing or building a custom system, feature, workflow, tool, integration, or automation, do a brief check for open-source projects, maintained libraries, existing OpenClaw plugins, or free platforms that already solve it well enough. Prefer those when adequate. Build custom only when existing options are unsuitable, too expensive, unmaintained, unsafe, non-compliant, or the user explicitly asks for custom. Avoid paid-service recommendations unless the user explicitly approves spend. Keep this lightweight: a preflight gate, not a broad research assignment.

## Session start (required)

- Read `SOUL.md`, `USER.md`, and today+yesterday in `memory/`.
- Read `MEMORY.md` when present.
- Do it before responding.

## Soul (required)

- `SOUL.md` defines identity, tone, and boundaries. Keep it current.
- If you change `SOUL.md`, tell the user.
- You are a fresh instance each session; continuity lives in these files.

## Shared spaces (recommended)

- You're not the user's voice; be careful in group chats or public channels.
- Don't share private data, contact info, or internal notes.

## Memory system (recommended)

- Daily log: `memory/YYYY-MM-DD.md` (create `memory/` if needed).
- Long-term memory: `MEMORY.md` for durable facts, preferences, and decisions.
- Lowercase `memory.md` is legacy repair input only; do not keep both root files on purpose.
- On session start, read today + yesterday + `MEMORY.md` when present.
- Before writing memory files, read them first; write only concrete updates, never empty placeholders.
- Capture: decisions, preferences, constraints, open loops.
- Avoid secrets unless explicitly requested.

## Tools and skills

- Tools live in skills; follow each skill's `SKILL.md` when you need it.
- Keep environment-specific notes in `TOOLS.md` (Notes for Skills).

## Backup tip (recommended)

If you treat this workspace as Clawd's "memory", make it a git repo (ideally private) so `AGENTS.md` and your memory files are backed up.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## What OpenClaw does

- Runs WhatsApp gateway + embedded OpenClaw agent so the assistant can read/write chats, fetch context, and run skills via the host Mac.
- macOS app manages permissions (screen recording, notifications, microphone) and exposes the `openclaw` CLI via its bundled binary.
- Direct chats collapse into the agent's `main` session by default; groups stay isolated as `agent:<agentId>:<channel>:group:<id>` (rooms/channels: `agent:<agentId>:<channel>:channel:<id>`); heartbeats keep background tasks alive.

## Bundled and plugin skills (enable in Settings → Skills)

- **clawhub** - Search, verify, install, update, and publish ClawHub skills.
- **summarize** - Summarize or transcribe URLs, media, PDFs, and local files.
- **weather** - Current weather and forecasts.
- **node-connect** - Diagnose node pairing, routing, authentication, and connection failures.
- **Peekaboo** - Capture and automate the macOS UI.
- **mcporter** - Configure, authenticate, call, and inspect MCP servers and tools.
- **gog** - Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
- **spotify-player** - Terminal Spotify playback and search.
- **diagram-maker** - Create diagrams and whiteboards.
- **gifgrep** - Search GIF providers, download results, and extract stills or sheets.
- **songsee** - Generate spectrograms and audio feature visualizations.
- **healthcheck** - Audit and harden OpenClaw hosts.
- **model-usage** - Summarize local model cost logs.
- **skill-creator** - Create, audit, and validate skills.
- **canvas** - Present and inspect HTML on connected node canvases.
- **discord** - Discord message actions when the Discord plugin is configured.
- **slack** - Slack message actions when the Slack plugin is configured.
- **wacli** - WhatsApp history sync, search, and third-party sends when its CLI is installed.
- **voice-call** - Start or inspect calls when the voice-call plugin is configured.

## Usage notes

- Prefer the `openclaw` CLI for scripting; mac app handles permissions.
- Run installs from the Skills tab; it hides the button if a binary is already present.
- Keep heartbeats enabled so the assistant can schedule reminders, monitor inboxes, and trigger camera captures.
- Canvas UI runs full-screen with native overlays. Avoid placing critical controls in the top-left/top-right/bottom edges; add explicit gutters in the layout and don't rely on safe-area insets.
- For browser-driven verification, use `openclaw browser` (tabs/status/screenshot) with the OpenClaw-managed Chrome profile.
- For DOM inspection, use `openclaw browser eval|query|dom|snapshot` (and `--json`/`--out` when you need machine output).
- For interactions, use `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (click/type require snapshot refs; use `evaluate` for CSS selectors).

## Related

- [Agent workspace](/concepts/agent-workspace)
- [Agent runtime](/concepts/agent)
