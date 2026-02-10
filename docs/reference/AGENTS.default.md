---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Default AGENTS.md"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Default OpenClaw agent instructions and skills roster for the personal assistant setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Starting a new OpenClaw agent session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Enabling or auditing default skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# AGENTS.md — OpenClaw Personal Assistant (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First run (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses a dedicated workspace directory for the agent. Default: `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create the workspace (if it doesn’t already exist):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Copy the default workspace templates into the workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Optional: if you want the personal assistant skill roster, replace AGENTS.md with this file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Optional: choose a different workspace by setting `agents.defaults.workspace` (supports `~`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don’t dump directories or secrets into chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don’t run destructive commands unless explicitly asked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don’t send partial/streaming replies to external messaging surfaces (only final replies).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session start (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read `SOUL.md`, `USER.md`, `memory.md`, and today+yesterday in `memory/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do it before responding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Soul (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SOUL.md` defines identity, tone, and boundaries. Keep it current.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you change `SOUL.md`, tell the user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You are a fresh instance each session; continuity lives in these files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Shared spaces (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You’re not the user’s voice; be careful in group chats or public channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don’t share private data, contact info, or internal notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory system (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daily log: `memory/YYYY-MM-DD.md` (create `memory/` if needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Long-term memory: `memory.md` for durable facts, preferences, and decisions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On session start, read today + yesterday + `memory.md` if present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capture: decisions, preferences, constraints, open loops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid secrets unless explicitly requested.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tools & skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools live in skills; follow each skill’s `SKILL.md` when you need it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep environment-specific notes in `TOOLS.md` (Notes for Skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Backup tip (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you treat this workspace as Clawd’s “memory”, make it a git repo (ideally private) so `AGENTS.md` and your memory files are backed up.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git init（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add AGENTS.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git commit -m "Add Clawd workspace"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional: add a private remote + push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What OpenClaw Does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs WhatsApp gateway + Pi coding agent so the assistant can read/write chats, fetch context, and run skills via the host Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app manages permissions (screen recording, notifications, microphone) and exposes the `openclaw` CLI via its bundled binary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats collapse into the agent's `main` session by default; groups stay isolated as `agent:<agentId>:<channel>:group:<id>` (rooms/channels: `agent:<agentId>:<channel>:channel:<id>`); heartbeats keep background tasks alive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core Skills (enable in Settings → Skills)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **mcporter** — Tool server runtime/CLI for managing external skill backends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Peekaboo** — Fast macOS screenshots with optional AI vision analysis.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **camsnap** — Capture frames, clips, or motion alerts from RTSP/ONVIF security cams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **oracle** — OpenAI-ready agent CLI with session replay and browser control.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **eightctl** — Control your sleep, from the terminal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **imsg** — Send, read, stream iMessage & SMS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **wacli** — WhatsApp CLI: sync, search, send.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **discord** — Discord actions: react, stickers, polls. Use `user:<id>` or `channel:<id>` targets (bare numeric ids are ambiguous).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **spotify-player** — Terminal Spotify client to search/queue/control playback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **sag** — ElevenLabs speech with mac-style say UX; streams to speakers by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sonos CLI** — Control Sonos speakers (discover/status/playback/volume/grouping) from scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **blucli** — Play, group, and automate BluOS players from scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenHue CLI** — Philips Hue lighting control for scenes and automations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenAI Whisper** — Local speech-to-text for quick dictation and voicemail transcripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gemini CLI** — Google Gemini models from the terminal for fast Q&A.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **agent-tools** — Utility toolkit for automations and helper scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer the `openclaw` CLI for scripting; mac app handles permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run installs from the Skills tab; it hides the button if a binary is already present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep heartbeats enabled so the assistant can schedule reminders, monitor inboxes, and trigger camera captures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvas UI runs full-screen with native overlays. Avoid placing critical controls in the top-left/top-right/bottom edges; add explicit gutters in the layout and don’t rely on safe-area insets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For browser-driven verification, use `openclaw browser` (tabs/status/screenshot) with the OpenClaw-managed Chrome profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For DOM inspection, use `openclaw browser eval|query|dom|snapshot` (and `--json`/`--out` when you need machine output).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For interactions, use `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (click/type require snapshot refs; use `evaluate` for CSS selectors).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
