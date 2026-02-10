---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent runtime (embedded pi-mono), workspace contract, and session bootstrap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing agent runtime, workspace bootstrap, or session behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Agent Runtime"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Runtime 🤖（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw runs a single embedded agent runtime derived from **pi-mono**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workspace (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses a single agent workspace directory (`agents.defaults.workspace`) as the agent’s **only** working directory (`cwd`) for tools and context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended: use `openclaw setup` to create `~/.openclaw/openclaw.json` if missing and initialize the workspace files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.defaults.sandbox` is enabled, non-main sessions can override this with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
per-session workspaces under `agents.defaults.sandbox.workspaceRoot` (see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Gateway configuration](/gateway/configuration)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bootstrap files (injected)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside `agents.defaults.workspace`, OpenClaw expects these user-editable files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `AGENTS.md` — operating instructions + “memory”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SOUL.md` — persona, boundaries, tone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TOOLS.md` — user-maintained tool notes (e.g. `imsg`, `sag`, conventions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `BOOTSTRAP.md` — one-time first-run ritual (deleted after completion)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `IDENTITY.md` — agent name/vibe/emoji（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `USER.md` — user profile + preferred address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On the first turn of a new session, OpenClaw injects the contents of these files directly into the agent context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blank files are skipped. Large files are trimmed and truncated with a marker so prompts stay lean (read the file for full content).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a file is missing, OpenClaw injects a single “missing file” marker line (and `openclaw setup` will create a safe default template).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`BOOTSTRAP.md` is only created for a **brand new workspace** (no other bootstrap files present). If you delete it after completing the ritual, it should not be recreated on later restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To disable bootstrap file creation entirely (for pre-seeded workspaces), set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ agent: { skipBootstrap: true } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Built-in tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core tools (read/exec/edit/write and related system tools) are always available,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
subject to tool policy. `apply_patch` is optional and gated by（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.exec.applyPatch`. `TOOLS.md` does **not** control which tools exist; it’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
guidance for how _you_ want them used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw loads skills from three locations (workspace wins on name conflict):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bundled (shipped with the install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Managed/local: `~/.openclaw/skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace: `<workspace>/skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills can be gated by config/env (see `skills` in [Gateway configuration](/gateway/configuration)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## pi-mono integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reuses pieces of the pi-mono codebase (models/tools), but **session management, discovery, and tool wiring are OpenClaw-owned**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No pi-coding agent runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No `~/.pi/agent` or `<workspace>/.pi` settings are consulted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session transcripts are stored as JSONL at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The session ID is stable and chosen by OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy Pi/Tau session folders are **not** read.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Steering while streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When queue mode is `steer`, inbound messages are injected into the current run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The queue is checked **after each tool call**; if a queued message is present,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remaining tool calls from the current assistant message are skipped (error tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
results with "Skipped due to queued user message."), then the queued user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message is injected before the next assistant response.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When queue mode is `followup` or `collect`, inbound messages are held until the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
current turn ends, then a new agent turn starts with the queued payloads. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Queue](/concepts/queue) for mode + debounce/cap behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block streaming sends completed assistant blocks as soon as they finish; it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**off by default** (`agents.defaults.blockStreamingDefault: "off"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tune the boundary via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; defaults to text_end).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control soft block chunking with `agents.defaults.blockStreamingChunk` (defaults to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
800–1200 chars; prefers paragraph breaks, then newlines; sentences last).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Coalesce streamed chunks with `agents.defaults.blockStreamingCoalesce` to reduce（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
single-line spam (idle-based merging before send). Non-Telegram channels require（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
explicit `*.blockStreaming: true` to enable block replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verbose tool summaries are emitted at tool start (no debounce); Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streams tool output via agent events when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More details: [Streaming + chunking](/concepts/streaming).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model refs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model refs in config (for example `agents.defaults.model` and `agents.defaults.models`) are parsed by splitting on the **first** `/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `provider/model` when configuring models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the model ID itself contains `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you omit the provider, OpenClaw treats the input as an alias or a model for the **default provider** (only works when there is no `/` in the model ID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration (minimal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
At minimum, set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.whatsapp.allowFrom` (strongly recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
_Next: [Group Chats](/channels/group-messages)_ 🦞（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
