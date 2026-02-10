---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "End-to-end guide for running OpenClaw as a personal assistant with safety cautions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Onboarding a new assistant instance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reviewing safety/permission implications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Personal Assistant Setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Building a personal assistant with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is a WhatsApp + Telegram + Discord + iMessage gateway for **Pi** agents. Plugins add Mattermost. This guide is the "personal assistant" setup: one dedicated WhatsApp number that behaves like your always-on agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ⚠️ Safety first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You’re putting an agent in a position to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- run commands on your machine (depending on your Pi tool setup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- read/write files in your workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- send messages back out via WhatsApp/Telegram/Discord/Mattermost (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start conservative:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always set `channels.whatsapp.allowFrom` (never run open-to-the-world on your personal Mac).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a dedicated WhatsApp number for the assistant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeats now default to every 30 minutes. Disable until you trust the setup by setting `agents.defaults.heartbeat.every: "0m"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw installed and onboarded — see [Getting Started](/start/getting-started) if you haven't done this yet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A second phone number (SIM/eSIM/prepaid) for the assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The two-phone setup (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You want this:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```mermaid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
%%{init: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'theme': 'base',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'themeVariables': {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryTextColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryBorderColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'lineColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'secondaryColor': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'tertiaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBkg': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'nodeBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'mainBkg': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'edgeLabelBackground': '#ffffff'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}}%%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flowchart TB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    A["<b>Your Phone (personal)<br></b><br>Your WhatsApp<br>+1-555-YOU"] -- message --> B["<b>Second Phone (assistant)<br></b><br>Assistant WA<br>+1-555-ASSIST"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    B -- linked via QR --> C["<b>Your Mac (openclaw)<br></b><br>Pi agent"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you link your personal WhatsApp to OpenClaw, every message to you becomes “agent input”. That’s rarely what you want.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5-minute quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Pair WhatsApp Web (shows QR; scan with the assistant phone):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Start the Gateway (leave it running):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Put a minimal config in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Now message the assistant number from your allowlisted phone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When onboarding finishes, we auto-open the dashboard and print a clean (non-tokenized) link. If it prompts for auth, paste the token from `gateway.auth.token` into Control UI settings. To reopen later: `openclaw dashboard`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Give the agent a workspace (AGENTS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads operating instructions and “memory” from its workspace directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, OpenClaw uses `~/.openclaw/workspace` as the agent workspace, and will create it (plus starter `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatically on setup/first agent run. `BOOTSTRAP.md` is only created when the workspace is brand new (it should not come back after you delete it). `MEMORY.md` is optional (not auto-created); when present, it is loaded for normal sessions. Subagent sessions only inject `AGENTS.md` and `TOOLS.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: treat this folder like OpenClaw’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up. If git is installed, brand-new workspaces are auto-initialized.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Memory workflow: [Memory](/concepts/memory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional: choose a different workspace with `agents.defaults.workspace` (supports `~`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    workspace: "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you already ship your own workspace files from a repo, you can disable bootstrap file creation entirely:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    skipBootstrap: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The config that turns it into “an assistant”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw defaults to a good assistant setup, but you’ll usually want to tune:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- persona/instructions in `SOUL.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- thinking defaults (if desired)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- heartbeats (once you trust it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  logging: { level: "info" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    workspace: "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    thinkingDefault: "high",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    timeoutSeconds: 1800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Start with 0; enable later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat: { every: "0m" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  routing: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    groupChat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mentionPatterns: ["@openclaw", "openclaw"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope: "per-sender",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetTriggers: ["/new", "/reset"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reset: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "daily",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      atHour: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      idleMinutes: 10080,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions and memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session files: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session metadata (token usage, last route, etc): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/new` or `/reset` starts a fresh session for that chat (configurable via `resetTriggers`). If sent alone, the agent replies with a short hello to confirm the reset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/compact [instructions]` compacts the session context and reports the remaining context budget.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Heartbeats (proactive mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, OpenClaw runs a heartbeat every 30 minutes with the prompt:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `agents.defaults.heartbeat.every: "0m"` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the file is missing, the heartbeat still runs and the model decides what to do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the agent replies with `HEARTBEAT_OK` (optionally with short padding; see `agents.defaults.heartbeat.ackMaxChars`), OpenClaw suppresses outbound delivery for that heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeats run full agent turns — shorter intervals burn more tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat: { every: "30m" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media in and out（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound attachments (images/audio/docs) can be surfaced to your command via templates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{MediaPath}}` (local temp file path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{MediaUrl}}` (pseudo-URL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `{{Transcript}}` (if audio transcription is enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound attachments from the agent: include `MEDIA:<path-or-url>` on its own line (no spaces). Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Here’s the screenshot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MEDIA:https://example.com/screenshot.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw extracts these and sends them as media alongside the text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operations checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status          # local status (creds, sessions, queued events)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --all    # full diagnosis (read-only, pasteable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --deep   # adds gateway health probes (Telegram + Discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health --json   # gateway health snapshot (WS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Logs live under `/tmp/openclaw/` (default: `openclaw-YYYY-MM-DD.log`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Next steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebChat: [WebChat](/web/webchat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway ops: [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS menu bar companion: [OpenClaw macOS app](/platforms/macos)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS node app: [iOS app](/platforms/ios)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android node app: [Android app](/platforms/android)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows status: [Windows (WSL2)](/platforms/windows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux status: [Linux app](/platforms/linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
