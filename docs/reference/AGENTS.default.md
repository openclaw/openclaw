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
- Don't send partial/streaming replies to external messaging surfaces (only final replies).

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

- Runs WhatsApp gateway + Pi coding agent so the assistant can read/write chats, fetch context, and run skills via the host Mac.
- macOS app manages permissions (screen recording, notifications, microphone) and exposes the `openclaw` CLI via its bundled binary.
- Direct chats collapse into the agent's `main` session by default; groups stay isolated as `agent:<agentId>:<channel>:group:<id>` (rooms/channels: `agent:<agentId>:<channel>:channel:<id>`); heartbeats keep background tasks alive.

## Core skills (enable in Settings → Skills)

- **mcporter** - Tool server runtime/CLI for managing external skill backends.
- **Peekaboo** - Fast macOS screenshots with optional AI vision analysis.
- **camsnap** - Capture frames, clips, or motion alerts from RTSP/ONVIF security cams.
- **oracle** - OpenAI-ready agent CLI with session replay and browser control.
- **eightctl** - Control your sleep, from the terminal.
- **imsg** - Send, read, stream iMessage & SMS.
- **wacli** - WhatsApp CLI: sync, search, send.
- **discord** - Discord actions: react, stickers, polls. Use `user:<id>` or `channel:<id>` targets (bare numeric ids are ambiguous).
- **gog** - Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** - Terminal Spotify client to search/queue/control playback.
- **sag** - ElevenLabs speech with mac-style say UX; streams to speakers by default.
- **Sonos CLI** - Control Sonos speakers (discover/status/playback/volume/grouping) from scripts.
- **blucli** - Play, group, and automate BluOS players from scripts.
- **OpenHue CLI** - Philips Hue lighting control for scenes and automations.
- **OpenAI Whisper** - Local speech-to-text for quick dictation and voicemail transcripts.
- **Gemini CLI** - Google Gemini models from the terminal for fast Q&A.
- **agent-tools** - Utility toolkit for automations and helper scripts.

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

<!--
================================================================================
Configuration notes / 配置说明

These annotations help Chinese-speaking users understand key configuration items.
These annotations do not affect agent behavior.

以下是对主要配置项的中文说明，帮助中文用户理解各项配置的作用。
这些注释不影响 AI 助手的实际行为。
================================================================================

workspace (~/.openclaw/workspace):
  Agent 的工作目录，所有文件操作默认在此目录下进行。
  可通过 agents.defaults.workspace 配置修改。

agents.defaults.workspace:
  配置项，用于指定 Agent 的工作区路径，支持 ~ 符号（代表用户主目录）。
  Example: { "agents": { "defaults": { "workspace": "~/.openclaw/workspace" } } }

Safety defaults (安全默认设置):
  - 禁止在聊天中泄露目录结构和密钥
  - 未明确要求时禁止执行破坏性命令
  - 不向外部消息平台发送部分/流式回复（仅发送完整回复）

Session start (会话启动):
  Agent 每次启动时必须读取 SOUL.md 和 USER.md 以及当天的记忆文件。
  若有 MEMORY.md（长期记忆）也必须读取。

Soul (人格定义):
  SOUL.md 定义了 AI 的身份、语气和行为边界。
  如果修改了 SOUL.md，必须告知用户。

Memory system (记忆系统):
  - memory/YYYY-MM-DD.md: 每日原始记录
  - MEMORY.md: 精心整理的长期记忆
  - 每次会话启动时读取当天 + 昨天的记录 + 长期记忆

Tools and skills (工具与技能):
  - 工具由技能（Skill）提供，需要使用时查看对应技能的 SKILL.md
  - 环境相关的配置信息记录在 TOOLS.md 中

Backup tip (备份建议):
  建议将工作区设为 git 仓库（最好是私有仓库），方便备份 AGENTS.md 和记忆文件。

Core skills (核心技能列表):
  以下技能可在 OpenClaw 设置 → Skills 中启用。
  - mcporter: 管理外部技能后端的工具服务器
  - Peekaboo: macOS 截图工具，支持 AI 视觉分析
  - camsnap: 从 RTSP/ONVIF 安防摄像头捕获画面或告警
  - oracle: 支持会话回放和浏览器控制的 CLI 工具
  - imsg: iMessage 和 SMS 消息读写
  - wacli: WhatsApp 命令行工具
  - discord: Discord 互动（表情反应、贴纸、投票等）
  - gog: Google 套件 CLI（Gmail、日历、云端硬盘、联系人）
  - spotify-player: 终端 Spotify 播放控制
  - sag: ElevenLabs 语音合成（默认输出到扬声器）
  - OpenAI Whisper: 本地语音转文字
  - Gemini CLI: 终端中使用 Google Gemini 模型

Usage notes (使用说明):
  - 推荐使用 openclaw CLI 编写脚本
  - 保持心跳（heartbeat）开启，以便 AI 能定时检查日程、提醒等
  - Canvas UI 全屏运行时，注意四边不要放置关键控件
  - 浏览器操作可通过 openclaw browser 命令完成
-->
<!--
Note to maintainers:
If this addition is found useful, there is a follow-up plan to integrate
an optional wizard prompt that asks Chinese users whether they want these
annotations applied during setup. See the related PR for details.

致维护者：
如果您认为此内容有价值，后续计划在安装向导中增加一个可选项，
询问中国用户是否需要应用这些中文注释。详情请参阅关联 PR。
-->
