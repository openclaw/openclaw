---
summary: "Default Clawdis agent instructions and skills roster for the personal assistant setup"
read_when:
  - Starting a new Clawdis agent session
  - Enabling or auditing default skills
---
# AGENTS.md — Clawdis Personal Assistant (default)

## First run (recommended)

Clawdis uses a dedicated workspace directory for the agent. Default: `~/.clawdis/workspace`.

1) Create the workspace (if it doesn’t already exist):

```bash
mkdir -p ~/.clawdis/workspace
```

2) Copy the default workspace templates into the workspace:

```bash
cp docs/templates/AGENTS.md ~/.clawdis/workspace/AGENTS.md
cp docs/templates/SOUL.md ~/.clawdis/workspace/SOUL.md
cp docs/templates/TOOLS.md ~/.clawdis/workspace/TOOLS.md
```

3) Optional: if you want the personal assistant skill roster, replace AGENTS.md with this file:

```bash
cp docs/AGENTS.default.md ~/.clawdis/workspace/AGENTS.md
```

4) Optional: choose a different workspace by setting `inbound.workspace` (supports `~`):

```json5
{
  inbound: {
    workspace: "~/clawd"
  }
}
```

## Safety defaults
- Don’t dump directories or secrets into chat.
- Don’t run destructive commands unless explicitly asked.
- Don’t send partial/streaming replies to external messaging surfaces (only final replies).

## Daily memory (recommended)
- Keep a short daily log at `memory/YYYY-MM-DD.md` (create `memory/` if needed).
- On session start, read today + yesterday if present.
- Capture durable facts, preferences, and decisions; avoid secrets.

## Backup tip (recommended)
If you treat this workspace as Clawd’s “memory”, make it a git repo (ideally private) so `AGENTS.md` and your memory files are backed up.

```bash
cd ~/.clawdis/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## What Clawdis Does
- Runs WhatsApp gateway + Pi coding agent so the assistant can read/write chats, fetch context, and run skills via the host Mac.
- macOS app manages permissions (screen recording, notifications, microphone) and exposes the `clawdis` CLI via its bundled binary.
- Direct chats collapse into the shared `main` session by default; groups stay isolated as `group:<jid>`; heartbeats keep background tasks alive.

## Core Skills (enable in Settings → Skills)
- **mcporter** — Tool server runtime/CLI for managing external skill backends.
- **Peekaboo** — Fast macOS screenshots with optional AI vision analysis.
- **camsnap** — Capture frames, clips, or motion alerts from RTSP/ONVIF security cams.
- **oracle** — OpenAI-ready agent CLI with session replay and browser control.
- **qmd** — Hybrid markdown search (BM25 + vectors + rerank) with a local server for agents.
- **eightctl** — Control your sleep, from the terminal.
- **imsg** — Send, read, stream iMessage & SMS.
- **wacli** — WhatsApp CLI: sync, search, send.
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Terminal Spotify client to search/queue/control playback.
- **sag** — ElevenLabs speech with mac-style say UX; streams to speakers by default.
- **Sonos CLI** — Control Sonos speakers (discover/status/playback/volume/grouping) from scripts.
- **blucli** — Play, group, and automate BluOS players from scripts.
- **OpenHue CLI** — Philips Hue lighting control for scenes and automations.
- **OpenAI Whisper** — Local speech-to-text for quick dictation and voicemail transcripts.
- **Gemini CLI** — Google Gemini models from the terminal for fast Q&A.
- **bird** — X/Twitter CLI to tweet, reply, read threads, and search without a browser.
- **agent-tools** — Utility toolkit for automations and helper scripts.

## Usage Notes
- Prefer the `clawdis` CLI for scripting; mac app handles permissions.
- Run installs from the Skills tab; it hides the button if a binary is already present.
- Keep heartbeats enabled so the assistant can schedule reminders, monitor inboxes, and trigger camera captures.
- For browser-driven verification, use `clawdis browser` (tabs/status/screenshot) with the clawd-managed Chrome profile.
- For DOM inspection, use `clawdis browser eval|query|dom|snapshot` (and `--json`/`--out` when you need machine output).
- For interactions, use `clawdis browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`.
