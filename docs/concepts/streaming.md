---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Streaming + chunking behavior (block replies, draft streaming, limits)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explaining how streaming or chunking works on channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing block streaming or channel chunking behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging duplicate/early block replies or draft streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Streaming and Chunking"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Streaming + chunking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has two separate “streaming” layers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Block streaming (channels):** emit completed **blocks** as the assistant writes. These are normal channel messages (not token deltas).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Token-ish streaming (Telegram only):** update a **draft bubble** with partial text while generating; final message is sent at the end.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There is **no real token streaming** to external channel messages today. Telegram draft streaming is the only partial-stream surface.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Block streaming (channel messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block streaming sends assistant output in coarse chunks as it becomes available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  └─ text_delta/events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       ├─ (blockStreamingBreak=text_end)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       │    └─ chunker emits blocks as buffer grows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       └─ (blockStreamingBreak=message_end)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            └─ chunker flushes at message_end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                   └─ channel send (block replies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legend:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `text_delta/events`: model stream events (may be sparse for non-streaming models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chunker`: `EmbeddedBlockChunker` applying min/max bounds + break preference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel send`: actual outbound messages (block replies).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Controls:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default off).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel overrides: `*.blockStreaming` (and per-account variants) to force `"on"`/`"off"` per channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"message_end"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (merge streamed blocks before send).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel hard cap: `*.textChunkLimit` (e.g., `channels.whatsapp.textChunkLimit`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel chunk mode: `*.chunkMode` (`length` default, `newline` splits on blank lines (paragraph boundaries) before length chunking).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord soft cap: `channels.discord.maxLinesPerMessage` (default 17) splits tall replies to avoid UI clipping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Boundary semantics:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `text_end`: stream blocks as soon as chunker emits; flush on each `text_end`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message_end`: wait until assistant message finishes, then flush buffered output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`message_end` still uses the chunker if the buffered text exceeds `maxChars`, so it can emit multiple chunks at the end.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chunking algorithm (low/high bounds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block chunking is implemented by `EmbeddedBlockChunker`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Low bound:** don’t emit until buffer >= `minChars` (unless forced).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **High bound:** prefer splits before `maxChars`; if forced, split at `maxChars`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Break preference:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Code fences:** never split inside fences; when forced at `maxChars`, close + reopen the fence to keep Markdown valid.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`maxChars` is clamped to the channel `textChunkLimit`, so you can’t exceed per-channel caps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Coalescing (merge streamed blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When block streaming is enabled, OpenClaw can **merge consecutive block chunks**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
before sending them out. This reduces “single-line spam” while still providing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
progressive output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Coalescing waits for **idle gaps** (`idleMs`) before flushing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Buffers are capped by `maxChars` and will flush if they exceed it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minChars` prevents tiny fragments from sending until enough text accumulates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (final flush always sends remaining text).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Joiner is derived from `blockStreamingChunk.breakPreference`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel overrides are available via `*.blockStreamingCoalesce` (including per-account configs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default coalesce `minChars` is bumped to 1500 for Signal/Slack/Discord unless overridden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Human-like pacing between blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When block streaming is enabled, you can add a **randomized pause** between（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block replies (after the first block). This makes multi-bubble responses feel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
more natural.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `agents.defaults.humanDelay` (override per agent via `agents.list[].humanDelay`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Modes: `off` (default), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Applies only to **block replies**, not final replies or tool summaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## “Stream chunks or everything”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This maps to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emit as you go). Non-Telegram channels also need `*.blockStreaming: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stream everything at end:** `blockStreamingBreak: "message_end"` (flush once, possibly multiple chunks if very long).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No block streaming:** `blockStreamingDefault: "off"` (only final reply).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Channel note:** For non-Telegram channels, block streaming is **off unless**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`*.blockStreaming` is explicitly set to `true`. Telegram can stream drafts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`channels.telegram.streamMode`) without block replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config location reminder: the `blockStreaming*` defaults live under（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults`, not the root config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Telegram draft streaming (token-ish)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram is the only channel with draft streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses Bot API `sendMessageDraft` in **private chats with topics**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.streamMode: "partial" | "block" | "off"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `partial`: draft updates with the latest stream text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `block`: draft updates in chunked blocks (same chunker rules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `off`: no draft streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Draft chunk config (only for `streamMode: "block"`): `channels.telegram.draftChunk` (defaults: `minChars: 200`, `maxChars: 800`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Draft streaming is separate from block streaming; block replies are off by default and only enabled by `*.blockStreaming: true` on non-Telegram channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Final reply is still a normal message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning stream` writes reasoning into the draft bubble (Telegram only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When draft streaming is active, OpenClaw disables block streaming for that reply to avoid double-streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram (private + topics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  └─ sendMessageDraft (draft bubble)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       ├─ streamMode=partial → update latest text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       └─ streamMode=block   → chunker updates draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  └─ final reply → normal message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legend:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendMessageDraft`: Telegram draft bubble (not a real message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `final reply`: normal Telegram message send.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
