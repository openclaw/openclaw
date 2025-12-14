---
summary: "Default Clawdis agent instructions and tool roster for the personal assistant setup"
read_when:
  - Starting a new Clawdis agent session
  - Enabling or auditing default tools
---
# AGENTS.md — Clawdis Personal Assistant (default)

## First run (recommended)

Clawdis uses a dedicated workspace directory for the agent. Default: `~/.clawdis/workspace`.

1) Create the workspace (if it doesn’t already exist):

```bash
mkdir -p ~/.clawdis/workspace
```

2) Copy this template into the workspace as `AGENTS.md` (overwrites any existing file):

```bash
cp docs/AGENTS.default.md ~/.clawdis/workspace/AGENTS.md
```

3) Optional: choose a different workspace by setting `inbound.workspace` (supports `~`):

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

## What Clawdis Does
- Runs WhatsApp gateway + Pi coding agent so the assistant can read/write chats, fetch context, and run tools via the host Mac.
- macOS app manages permissions (screen recording, notifications, microphone) and exposes a CLI helper `clawdis-mac` for scripts.
- Direct chats collapse into the shared `main` session by default; groups stay isolated as `group:<jid>`; heartbeats keep background tasks alive.

## Core Tools (enable in Settings → Tools)
- **mcporter** — MCP runtime/CLI to list, call, and sync Model Context Protocol servers.
- **Peekaboo** — Fast macOS screenshots with optional AI vision analysis.
- **camsnap** — Capture frames, clips, or motion alerts from RTSP/ONVIF security cams.
- **oracle** — OpenAI-ready agent CLI with session replay and browser control.
- **qmd** — Hybrid markdown search (BM25 + vectors + rerank) with an MCP server for agents.
- **eightctl** — Control your sleep, from the terminal.
- **imsg** — Send, read, stream iMessage & SMS.
- **wacli** — WhatsApp CLI: sync, search, send.
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Terminal Spotify client to search/queue/control playback.
- **sag** — ElevenLabs speech with mac-style say UX; streams to speakers by default.
- **Sonos CLI** — Control Sonos speakers (discover/status/playback/volume/grouping) from scripts.
- **OpenHue CLI** — Philips Hue lighting control for scenes and automations.
- **OpenAI Whisper** — Local speech-to-text for quick dictation and voicemail transcripts.
- **Gemini CLI** — Google Gemini models from the terminal for fast Q&A.
- **bird** — X/Twitter CLI to tweet, reply, read threads, and search without a browser.
- **agent-tools** — Utility toolkit for automations and MCP-friendly scripts.

## MCP Servers (added via mcporter)
- **Gmail MCP** (`gmail`) — Search, read, and send Gmail messages.
- **Google Calendar MCP** (`google-calendar`) — List, create, and update events.

## Usage Notes
- Prefer the `clawdis-mac` CLI for scripting; mac app handles permissions.
- Run installs from the Tools tab; it hides the button if a tool is already present.
- For MCPs, mcporter writes to the home-scope config; re-run installs if you rotate tokens.
- Keep heartbeats enabled so the assistant can schedule reminders, monitor inboxes, and trigger camera captures.
- For browser-driven verification, use `clawdis browser` (tabs/status/screenshot) with the clawd-managed Chrome profile.
- For DOM inspection, use `clawdis browser eval|query|dom|snapshot` (and `--json`/`--out` when you need machine output).
