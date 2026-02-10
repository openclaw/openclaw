---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Message flow, sessions, queueing, and reasoning visibility"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explaining how inbound messages become replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Clarifying sessions, queueing modes, or streaming behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Documenting reasoning visibility and usage implications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Messages"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page ties together how OpenClaw handles inbound messages, sessions, queueing,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming, and reasoning visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Message flow (high level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -> routing/bindings -> session key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -> queue (if a run is active)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -> agent run (streaming + tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -> outbound replies (channel limits + chunking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key knobs live in configuration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.*` for prefixes, queueing, and group behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.*` for block streaming and chunking defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel overrides (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for caps and streaming toggles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Configuration](/gateway/configuration) for full schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inbound dedupe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channels can redeliver the same message after reconnects. OpenClaw keeps a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
short-lived cache keyed by channel/account/peer/session/message id so duplicate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
deliveries do not trigger another agent run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inbound debouncing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rapid consecutive messages from the **same sender** can be batched into a single（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and uses the most recent message for reply threading/IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config (global default + per-channel overrides):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    inbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      debounceMs: 2000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      byChannel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        whatsapp: 5000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        slack: 1500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        discord: 1500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debounce applies to **text-only** messages; media/attachments flush immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control commands bypass debouncing so they remain standalone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions and devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sessions are owned by the gateway, not by clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats collapse into the agent main session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups/channels get their own session keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The session store and transcripts live on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multiple devices/channels can map to the same session, but history is not fully（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
synced back to every client. Recommendation: use one primary device for long（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
conversations to avoid divergent context. The Control UI and TUI always show the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gateway-backed session transcript, so they are the source of truth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Session management](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inbound bodies and history context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw separates the **prompt body** from the **command body**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Body`: prompt text sent to the agent. This may include channel envelopes and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  optional history wrappers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CommandBody`: raw user text for directive/command parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `RawBody`: legacy alias for `CommandBody` (kept for compatibility).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a channel supplies history, it uses a shared wrapper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[Chat messages since your last reply - for context]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[Current message - respond to this]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sender label (same style used for history entries). This keeps real-time and queued/history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
messages consistent in the agent prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
History buffers are **pending-only**: they include group messages that did _not_（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
trigger a run (for example, mention-gated messages) and **exclude** messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
already in the session transcript.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Directive stripping only applies to the **current message** section so history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remains intact. Channels that wrap history should set `CommandBody` (or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`RawBody`) to the original message text and keep `Body` as the combined prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
History buffers are configurable via `messages.groupChat.historyLimit` (global（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default) and per-channel overrides like `channels.slack.historyLimit` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Queueing and followups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a run is already active, inbound messages can be queued, steered into the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
current run, or collected for a followup turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure via `messages.queue` (and `messages.queue.byChannel`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Modes: `interrupt`, `steer`, `followup`, `collect`, plus backlog variants.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Queueing](/concepts/queue).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming, chunking, and batching（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block streaming sends partial replies as the model produces text blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chunking respects channel text limits and avoids splitting fenced code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key settings:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingDefault` (`on|off`, default off)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.humanDelay` (human-like pause between block replies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel overrides: `*.blockStreaming` and `*.blockStreamingCoalesce` (non-Telegram channels require explicit `*.blockStreaming: true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Streaming + chunking](/concepts/streaming).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reasoning visibility and tokens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can expose or hide model reasoning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning on|off|stream` controls visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reasoning content still counts toward token usage when produced by the model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram supports reasoning stream into the draft bubble.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Thinking + reasoning directives](/tools/thinking) and [Token use](/reference/token-use).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prefixes, threading, and replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound message formatting is centralized in `messages`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, and `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), plus `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply threading via `replyToMode` and per-channel defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Configuration](/gateway/configuration#messages) and channel docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
