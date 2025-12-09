# AGENTS.md — Clawdis Personal Assistant (default)

## What Clawdis Does
- Runs WhatsApp relay + Pi/Tau coding agent so the assistant can read/write chats, fetch context, and run tools via the host Mac.
- macOS app manages permissions (screen recording, notifications, microphone) and exposes a CLI helper `clawdis-mac` for scripts.
- Sessions are per-sender; heartbeats keep background tasks alive.

## Core Tools (enable in Settings → Tools)
- **mcporter** — MCP runtime/CLI to list, call, and sync Model Context Protocol servers.
- **Peekaboo** — Fast macOS screenshots with optional AI vision analysis.
- **camsnap** — Capture frames, clips, or motion alerts from RTSP/ONVIF security cams.
- **oracle** — OpenAI-ready agent CLI with session replay and browser control.
- **eightctl** — Control Eight Sleep Pod temperature, alarms, schedules, and metrics.
- **imsg** — macOS Messages CLI to read/tail chats and send iMessage/SMS.
- **spotify-player** — Terminal Spotify client to search/queue/control playback.
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
