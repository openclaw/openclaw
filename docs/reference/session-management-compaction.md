---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Deep dive: session store + transcripts, lifecycle, and (auto)compaction internals"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to debug session ids, transcript JSONL, or sessions.json fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are changing auto-compaction behavior or adding “pre-compaction” housekeeping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to implement memory flushes or silent system turns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Session Management Deep Dive"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session Management & Compaction (Deep Dive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document explains how OpenClaw manages sessions end-to-end:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session routing** (how inbound messages map to a `sessionKey`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session store** (`sessions.json`) and what it tracks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Transcript persistence** (`*.jsonl`) and its structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Transcript hygiene** (provider-specific fixups before runs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Context limits** (context window vs tracked tokens)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Compaction** (manual + auto-compaction) and where to hook pre-compaction work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Silent housekeeping** (e.g. memory writes that shouldn’t produce user-visible output)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a higher-level overview first, start with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/concepts/session](/concepts/session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/concepts/compaction](/concepts/compaction)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/concepts/session-pruning](/concepts/session-pruning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/reference/transcript-hygiene](/reference/transcript-hygiene)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Source of truth: the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is designed around a single **Gateway process** that owns session state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UIs (macOS app, web Control UI, TUI) should query the Gateway for session lists and token counts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In remote mode, session files are on the remote host; “checking your local Mac files” won’t reflect what the Gateway is using.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Two persistence layers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw persists sessions in two layers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Session store (`sessions.json`)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Key/value map: `sessionKey -> SessionEntry`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Small, mutable, safe to edit (or delete entries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Tracks session metadata (current session id, last activity, toggles, token counters, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Transcript (`<sessionId>.jsonl`)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Append-only transcript with tree structure (entries have `id` + `parentId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Stores the actual conversation + tool calls + compaction summaries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Used to rebuild the model context for future turns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## On-disk locations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per agent, on the Gateway host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram topic sessions: `.../<sessionId>-topic-<threadId>.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw resolves these via `src/config/sessions.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session keys (`sessionKey`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A `sessionKey` identifies _which conversation bucket_ you’re in (routing + isolation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common patterns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Main/direct chat (per agent): `agent:<agentId>:<mainKey>` (default `main`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group: `agent:<agentId>:<channel>:group:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Room/channel (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` or `...:room:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: `cron:<job.id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook: `hook:<uuid>` (unless overridden)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The canonical rules are documented at [/concepts/session](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session ids (`sessionId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each `sessionKey` points at a current `sessionId` (the transcript file that continues the conversation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules of thumb:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reset** (`/new`, `/reset`) creates a new `sessionId` for that `sessionKey`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Daily reset** (default 4:00 AM local time on the gateway host) creates a new `sessionId` on the next message after the reset boundary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Idle expiry** (`session.reset.idleMinutes` or legacy `session.idleMinutes`) creates a new `sessionId` when a message arrives after the idle window. When daily + idle are both configured, whichever expires first wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Implementation detail: the decision happens in `initSessionState()` in `src/auto-reply/reply/session.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session store schema (`sessions.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The store’s value type is `SessionEntry` in `src/config/sessions.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key fields (not exhaustive):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionId`: current transcript id (filename is derived from this unless `sessionFile` is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `updatedAt`: last activity timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionFile`: optional explicit transcript path override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chatType`: `direct | group | room` (helps UIs and send policy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider`, `subject`, `room`, `space`, `displayName`: metadata for group/channel labeling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Toggles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `sendPolicy` (per-session override)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model selection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `providerOverride`, `modelOverride`, `authProfileOverride`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token counters (best-effort / provider-dependent):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `compactionCount`: how often auto-compaction completed for this session key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memoryFlushAt`: timestamp for the last pre-compaction memory flush（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memoryFlushCompactionCount`: compaction count when the last flush ran（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The store is safe to edit, but the Gateway is the authority: it may rewrite or rehydrate entries as sessions run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transcript structure (`*.jsonl`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Transcripts are managed by `@mariozechner/pi-coding-agent`’s `SessionManager`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The file is JSONL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First line: session header (`type: "session"`, includes `id`, `cwd`, `timestamp`, optional `parentSession`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Then: session entries with `id` + `parentId` (tree)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notable entry types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message`: user/assistant/toolResult messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `custom_message`: extension-injected messages that _do_ enter model context (can be hidden from UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `custom`: extension state that does _not_ enter model context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `compaction`: persisted compaction summary with `firstKeptEntryId` and `tokensBefore`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `branch_summary`: persisted summary when navigating a tree branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw intentionally does **not** “fix up” transcripts; the Gateway uses `SessionManager` to read/write them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context windows vs tracked tokens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two different concepts matter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Model context window**: hard cap per model (tokens visible to the model)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Session store counters**: rolling stats written into `sessions.json` (used for /status and dashboards)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you’re tuning limits:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The context window comes from the model catalog (and can be overridden via config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `contextTokens` in the store is a runtime estimate/reporting value; don’t treat it as a strict guarantee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For more, see [/token-use](/reference/token-use).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compaction: what it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Compaction summarizes older conversation into a persisted `compaction` entry in the transcript and keeps recent messages intact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After compaction, future turns see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The compaction summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages after `firstKeptEntryId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Compaction is **persistent** (unlike session pruning). See [/concepts/session-pruning](/concepts/session-pruning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When auto-compaction happens (Pi runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the embedded Pi agent, auto-compaction triggers in two cases:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Overflow recovery**: the model returns a context overflow error → compact → retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Threshold maintenance**: after a successful turn, when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`contextTokens > contextWindow - reserveTokens`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Where:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `contextWindow` is the model’s context window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reserveTokens` is headroom reserved for prompts + the next model output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are Pi runtime semantics (OpenClaw consumes the events, but Pi decides when to compact).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compaction settings (`reserveTokens`, `keepRecentTokens`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pi’s compaction settings live in Pi settings:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  compaction: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reserveTokens: 16384,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    keepRecentTokens: 20000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw also enforces a safety floor for embedded runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `compaction.reserveTokens < reserveTokensFloor`, OpenClaw bumps it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default floor is `20000` tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `agents.defaults.compaction.reserveTokensFloor: 0` to disable the floor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If it’s already higher, OpenClaw leaves it alone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Why: leave enough headroom for multi-turn “housekeeping” (like memory writes) before compaction becomes unavoidable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Implementation: `ensurePiCompactionReserveTokens()` in `src/agents/pi-settings.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(called from `src/agents/pi-embedded-runner.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## User-visible surfaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can observe compaction and session state via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` (in any chat session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status` (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw sessions` / `sessions --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verbose mode: `🧹 Auto-compaction complete` + compaction count（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Silent housekeeping (`NO_REPLY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports “silent” turns for background tasks where the user should not see intermediate output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Convention:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The assistant starts its output with `NO_REPLY` to indicate “do not deliver a reply to the user”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw strips/suppresses this in the delivery layer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
As of `2026.1.10`, OpenClaw also suppresses **draft/typing streaming** when a partial chunk begins with `NO_REPLY`, so silent operations don’t leak partial output mid-turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pre-compaction “memory flush” (implemented)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: before auto-compaction happens, run a silent agentic turn that writes durable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
state to disk (e.g. `memory/YYYY-MM-DD.md` in the agent workspace) so compaction can’t（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
erase critical context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses the **pre-threshold flush** approach:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Monitor session context usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. When it crosses a “soft threshold” (below Pi’s compaction threshold), run a silent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   “write memory now” directive to the agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Use `NO_REPLY` so the user sees nothing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config (`agents.defaults.compaction.memoryFlush`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled` (default: `true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `softThresholdTokens` (default: `4000`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt` (user message for the flush turn)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `systemPrompt` (extra system prompt appended for the flush turn)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The default prompt/system prompt include a `NO_REPLY` hint to suppress delivery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The flush runs once per compaction cycle (tracked in `sessions.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The flush runs only for embedded Pi sessions (CLI backends skip it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pi also exposes a `session_before_compact` hook in the extension API, but OpenClaw’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flush logic lives on the Gateway side today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session key wrong? Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Store vs transcript mismatch? Confirm the Gateway host and the store path from `openclaw status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Compaction spam? Check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - model context window (too small)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - compaction settings (`reserveTokens` too high for the model window can cause earlier compaction)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - tool-result bloat: enable/tune session pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Silent turns leaking? Confirm the reply starts with `NO_REPLY` (exact token) and you’re on a build that includes the streaming suppression fix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
