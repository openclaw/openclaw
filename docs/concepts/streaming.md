---
summary: "Streaming + chunking behavior (block replies, draft streaming, limits)"
read_when:
  - Explaining how streaming or chunking works on providers
  - Changing block streaming or provider chunking behavior
  - Debugging duplicate/early block replies or draft streaming
---
# Streaming + chunking

Clawdbot has two separate “streaming” layers:
- **Block streaming (providers):** emit completed **blocks** as the assistant writes. These are normal provider messages (not token deltas).
- **Token-ish streaming (Telegram only):** update a **draft bubble** with partial text while generating; final message is sent at the end.

There is **no real token streaming** to external provider messages today. Telegram draft streaming is the only partial-stream surface.

## Block streaming (provider messages)

Block streaming sends assistant output in coarse chunks as it becomes available.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ provider send (block replies)
```
Legend:
- `text_delta/events`: model stream events (may be sparse for non-streaming models).
- `chunker`: `EmbeddedBlockChunker` applying min/max bounds + break preference.
- `provider send`: actual outbound messages (block replies).

**Controls:**
- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default on).
- Provider overrides: `*.blockStreaming` (and per-account variants) to force `"on"`/`"off"` per provider.
- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (merge streamed blocks before send).
- Provider hard cap: `*.textChunkLimit` (e.g., `whatsapp.textChunkLimit`).
- Discord soft cap: `discord.maxLinesPerMessage` (default 17) splits tall replies to avoid UI clipping.

**Boundary semantics:**
- `text_end`: stream blocks as soon as chunker emits; flush on each `text_end`.
- `message_end`: wait until assistant message finishes, then flush buffered output.

`message_end` still uses the chunker if the buffered text exceeds `maxChars`, so it can emit multiple chunks at the end.

## Chunking algorithm (low/high bounds)

Block chunking is implemented by `EmbeddedBlockChunker`:
- **Low bound:** don’t emit until buffer >= `minChars` (unless forced).
- **High bound:** prefer splits before `maxChars`; if forced, split at `maxChars`.
- **Break preference:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break.
- **Code fences:** never split inside fences; when forced at `maxChars`, close + reopen the fence to keep Markdown valid.

`maxChars` is clamped to the provider `textChunkLimit`, so you can’t exceed per-provider caps.

## Coalescing (merge streamed blocks)

When block streaming is enabled, Clawdbot can **merge consecutive block chunks**
before sending them out. This reduces “single-line spam” while still providing
progressive output.

- Coalescing waits for **idle gaps** (`idleMs`) before flushing.
- Buffers are capped by `maxChars` and will flush if they exceed it.
- `minChars` prevents tiny fragments from sending until enough text accumulates
  (final flush always sends remaining text).
- Joiner is derived from `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).
- Provider overrides are available via `*.blockStreamingCoalesce` (including per-account configs).

## “Stream chunks or everything”

This maps to:
- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emit as you go).
- **Stream everything at end:** `blockStreamingBreak: "message_end"` (flush once, possibly multiple chunks if very long).
- **No block streaming:** `blockStreamingDefault: "off"` (only final reply).

## Telegram draft streaming (token-ish)

Telegram is the only provider with draft streaming:
- Uses Bot API `sendMessageDraft` in **private chats with topics**.
- `telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: draft updates with the latest stream text.
  - `block`: draft updates in chunked blocks (same chunker rules).
  - `off`: no draft streaming.
- Final reply is still a normal message.
- `/reasoning stream` writes reasoning into the draft bubble (Telegram only).

When draft streaming is active, Clawdbot disables block streaming for that reply to avoid double-streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```
Legend:
- `sendMessageDraft`: Telegram draft bubble (not a real message).
- `final reply`: normal Telegram message send.
