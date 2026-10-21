---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "Messages"
---

Inbound messages move through routing, dedupe/debounce, an agent run, and outbound delivery:

```text
Inbound message
  -> routing/bindings -> session key
  -> dedupe + debounce
  -> queue (if a run is already active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Key config surfaces:

- `messages.*` for prefixes, queueing, inbound debounce, and group behavior.
- `agents.defaults.*` for block streaming, chunking, and silent-reply defaults.
- Channel overrides (`channels.telegram.*`, `channels.whatsapp.*`, etc.) for per-channel caps and streaming toggles.

See [Configuration](/gateway/configuration) for the full schema.

## Inbound dedupe

Channels can redeliver the same message after a reconnect. OpenClaw keeps an in-memory cache keyed by agent scope, channel route (channel + peer + account + thread), and message id, so a redelivered message does not trigger a second agent run. The cache entry expires after 20 minutes or once 5000 entries are tracked, whichever comes first.

## Inbound debouncing

Rapid text messages from the same sender can be batched into one agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation and uses the most recent message for reply threading/IDs. It is a quiet-window heuristic, not a guarantee that every part of a long message will arrive in one turn.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        discord: 1500,
        slack: 1500,
        whatsapp: 5000,
      },
    },
  },
}
```

- Debounce applies to text-only messages; media/attachments flush immediately.
- Control commands (stop/abort/status, etc.) bypass debouncing so they dispatch immediately.
- Telegram batches ordinary text by default after a 300ms quiet window. Other channels have no generic debounce delay unless configured.
- `messages.inbound.byChannel.<channel>` takes precedence over `messages.inbound.debounceMs`; either overrides the channel default. Set `0` to disable ordinary burst batching.
- For non-forwarded Telegram text, messages of at least 4000 characters allow up to 1500ms for continuations. Short and long messages share the same batch, without requiring consecutive message IDs. This automatic long-paste assembly remains active when ordinary batching is disabled.
- iMessage follows the same generic debounce policy. `imsg` 0.13.1 and newer coalesces Apple URL-preview split-sends before OpenClaw receives them, so no iMessage-specific debounce setting is needed.

Changes to `messages.inbound.debounceMs` and `messages.inbound.byChannel` apply without
reconnecting Discord, Feishu, iMessage, Mattermost, Microsoft Teams, Signal, Slack,
Telegram, or WhatsApp. Newly admitted inbound work uses the committed delay. A config change alone does not reschedule a pending batch;
later messages can update its idle delay within the original maximum deadline.
Explicit transport timing overrides remain fixed. Telegram's forwarded-message
collection window remains separate.

Once an immediate message is adopted, its dispatch remains owned by the Gateway
until completion, even after the webhook request returns. Suspension refuses new
requests while admitted turns finish; restart draining still blocks new agent work.

## Sessions and devices

Sessions are owned by the gateway, not by clients.

- Direct chats collapse into the agent's main session key.
- Groups/channels get their own session keys.
- The session store and transcripts live on the gateway host.

Multiple devices/channels can map to the same session, but history is not fully synced back to every client. Use one primary device for long conversations to avoid divergent context. The Control UI and TUI always show the gateway-backed session transcript, so they are the source of truth.

If publishing a live transcript update fails after an agent message is saved, OpenClaw keeps the saved message and logs a warning. Reload the session to refresh its transcript; the failed notification is not replayed automatically.

If a run fails or times out before an assistant reply is saved, its transcript receives one visible failure notice. Nested runs retain their own failure notices even after the requesting turn has ended.

Failure notices remain in chat history without becoming user instructions in later model requests. This also applies to notices saved by earlier versions; stored transcript bytes remain unchanged.

Details: [Session management](/concepts/session).

## Prompt bodies and history context

Channel plugins populate several text fields on the inbound context, from most to least preferred:

| Field             | Purpose                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `BodyForAgent`    | Model-facing text for the current turn. Falls back to `CommandBody` / `RawBody` / `Body` when unset.        |
| `BodyForCommands` | Clean text used for directive/command parsing. Falls back to `CommandBody` / `RawBody` / `Body` when unset. |
| `CommandBody`     | Legacy intermediate body; prefer `BodyForCommands`.                                                         |
| `RawBody`         | Deprecated alias for `CommandBody`.                                                                         |
| `Body`            | Legacy prompt body; may include channel envelopes and history wrappers.                                     |

When a channel supplies history, it wraps it with:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Thread starter and thread history notes use the same current-message marker after their context, keeping the request separate from earlier messages. Queued turns insert newly active goals before this marker. The marker is runtime context and does not change the saved user message. Ambient room events omit it and keep their optional-response policy.

For non-direct chats (groups/channels/rooms), the current message body is prefixed with the sender label, matching the style used for history entries. Directive stripping only applies to the current-message section, so history stays intact. Channels that wrap history should set `BodyForCommands` (or the legacy `CommandBody` / `RawBody`) to the original message text and keep `Body` as the combined prompt.

History buffers are pending-only: they include group messages that did not trigger a run (for example, mention-gated messages) and exclude messages already in the session transcript. Structured history, reply, forwarded, and channel metadata render as untrusted user-role context blocks during prompt assembly.

Configure history size with `messages.groupChat.historyLimit` (global default) or per-channel overrides such as `channels.slack.historyLimit` and `channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## Tool result metadata

Tool result `content` is the model-visible result; `details` is runtime metadata for UI rendering, diagnostics, media delivery, and plugins.

- `toolResult.details` is stripped before provider replay and before compaction input.
- Persisted session transcripts keep only bounded `details`; oversized metadata is replaced with a compact summary marked `persistedDetailsTruncated: true`.
- Display history retains tool status flags and session keys, plus command exit codes, durations, and bounded working directories when the tool provides them.
- Plugins and tools should put text the model must read in `content`, not only in `details`.

When a tool-error warning is the agent's only reply, WebChat displays and retains it. The warning does not by itself change a completed agent run into a runtime failure; the failed tool result remains recorded separately.

## Queueing and followups

When a run is already active, inbound messages steer into it by default. `messages.queue` controls the mode:

| Mode              | Behavior                                            |
| ----------------- | --------------------------------------------------- |
| `steer` (default) | Inject the new prompt into the active run.          |
| `followup`        | Run the message after the active run finishes.      |
| `collect`         | Batch compatible messages into one later turn.      |
| `interrupt`       | Abort the active run, then start the newest prompt. |

Messages with separate durable ingress admission, including Discord and Telegram messages, stay in separate followup turns even in `collect` mode. Compatible Gateway `chat.send` inputs can still combine.

The queue uses a built-in 500ms debounce for steer, followup, and collect batching. `messages.queue.cap` defaults to 20 queued messages, and `messages.queue.drop` defaults to `summarize` (`old` and `new` are also available). Configure per-channel overrides via `messages.queue.byChannel` and `messages.queue.debounceMsByChannel`.

Details: [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

## Channel run ownership

Channel plugins may preserve ordering, debounce input, and apply transport backpressure before a message enters the session queue. They should not impose a separate timeout around the agent turn itself. Once a message is routed to a session, the session, tool, and runtime lifecycle govern long-running work so all channels report and recover from slow turns consistently.

Once a turn is durably accepted, an unexpected failure before its answer produces a compact error reply in direct chats and explicitly addressed conversations where automatic replies are enabled. Progress acknowledgments do not replace that final outcome. The turn remains failed and is not replayed as a new inbound message; delivery policies and replies already sent through the message tool still apply.

A final source reply completes only the input it answers. When another input steers the same running agent, its answer or failure remains visible even if an earlier input already received a final reply through the message tool.

When delivery of the current input's reply is pending, OpenClaw waits for its outcome before sending a replacement answer or failure message.

With the OpenClaw runtime, an assistant turn that errors or is aborted after producing partial text, without tool calls, appears as a short failure marker in the next model request. Its unfinished text is not replayed, and the stored failed turn stays unchanged. Empty and placeholder-only failures remain excluded; failed tool calls keep their existing pairing rules. The marker does not establish whether an earlier action completed.

## Streaming, chunking, and batching

Block streaming sends partial replies as the model produces text blocks; chunking respects channel text limits and avoids splitting fenced code.

- `agents.defaults.blockStreamingDefault` (`on|off`, default `off`)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)
- `agents.defaults.humanDelay` (human-like pause between block replies)
- Channel overrides: `*.streaming.block.enabled` and `*.streaming.block.coalesce` on bundled channels; stale flat keys are migrated by `openclaw doctor --fix`. Block streaming is off unless explicitly enabled, on every channel including Telegram. QQ Bot is the exception: it has no `streaming.block` keys and streams block replies unless `channels.qqbot.streaming.mode` is `"off"`.

Details: [Streaming + chunking](/concepts/streaming).

## Reasoning visibility and tokens

- `/reasoning on|off|stream` controls visibility.
- Reasoning content still counts toward token usage when the model produces it.
- Telegram supports streaming reasoning into a transient draft bubble that is deleted after final delivery; use `/reasoning on` for persistent reasoning output.

Details: [Thinking + reasoning directives](/tools/thinking) and [Token use](/reference/token-use).

## Prefixes, threading, and replies

- Channels with reply-prefix support use `channels.<channel>.responsePrefix` and, when multi-account configuration is supported, `channels.<channel>.accounts.<id>.responsePrefix`. Account values win, including `""` to disable an inherited prefix. Use `"auto"` for the agent identity name or templates such as `"[{model}]"` for the selected model. Automatic-reply support is channel-specific. Doctor copies the global fallback into supported configured channel blocks when those current fields are unset; `messages.responsePrefix` remains as a fallback for implicit and custom channels.
- Explicit `message` tool and CLI text sends also apply the resolved prefix, without duplicating a prefix already present. They resolve identity placeholders but do not select a model; a prefix containing unresolved model, provider, or thinking-level placeholders is omitted entirely.
- Reply threading via `replyToMode` and per-channel defaults.

Details: [Configuration](/gateway/config-agents/messages-and-talk#messages) and channel docs.

## Agent reactions to WebChat prompts

During an admitted WebChat turn, the agent can acknowledge the current prompt with
the existing message tool:

```json
{ "action": "react", "emoji": "👍" }
```

Omit the target and message ID: the host binds this action to the committed current
prompt and the running agent's identity. Set `remove: true` with the same emoji to
remove that agent's reaction. Repeating an add or removal is a no-op. The reaction
appears in session history and live updates; it does not mirror to an inherited
external channel. External reactions still require the normal channel routing and
external message ID.

Runs without a current prompt, such as heartbeats and internal events, cannot add
prompt reactions. A prompt-targeted attempt fails locally rather than asking you
to configure an external channel. To react externally, pass an explicit
`channel`, `target`, and `messageId`.

Queued turns bind the reaction to their own committed prompt when execution
begins. Steering updates the current prompt only after the new input is committed
and consumed by the running agent; pending or rejected input does not retarget a
reaction. Collected inputs use their committed combined prompt.

Omit `final` or set `final: false` when more work follows. An added reaction with
explicit `final: true` can be the complete reply when the agent chooses it. Once
delivery is confirmed on the current source message, OpenClaw ends the turn without
requesting another text response. Removals, reactions to other messages, no-ops,
dry runs, and failed reactions never count. Normal message-tool permissions
still apply, and the current-prompt capability expires with its admitted turn.

## Silent replies

The silent token `NO_REPLY` is reserved for sessions connected to external message channels. Only a completed final whose entire text is `NO_REPLY`, ignoring casing and surrounding whitespace, requests silence. It intentionally ends a turn without another reply, including after a cross-chat send, a reaction, group chatter, or a deliberate yield, even when the admitted turn normally requires a reply. Subagents, private completions, the Control UI, and other internal sessions still must return a result or continue unfinished work.

Direct-message prompts omit silent-reply guidance. An exact `NO_REPLY` emitted by the model still follows this protocol; omitting the prompt guidance does not force an additional answer.

A truncated response or an unfinished tool turn is not a successful silent ending, even if its partial text is `NO_REPLY`. A completed final result already delivered to the current WebChat transcript satisfies the result requirement; a later `NO_REPLY` does not invalidate that delivered answer. Progress updates do not satisfy that requirement. Direct system-agent chat in the Control UI also requires a result: `NO_REPLY` or empty output follows the existing recovery or failure path, rather than silently completing the request.

An explicit reply expectation selected by trusted input handling takes precedence over these session defaults. For example, a late peer result can be optional even in WebChat, so consuming it does not demand another acknowledgment or repeat an answer already delivered.

`NO_REPLY` discards anything written this turn that was not sent, so send confirmations before ending silently. It does not retract delivered messages or cancel pending work. A leading `NO_REPLY\n` removes that one control line and delivers the remaining text unchanged; the remainder stays visible even if it is another `NO_REPLY`. Otherwise, a standalone `NO_REPLY` on the last non-empty line is removed and the preceding answer is delivered. Casing and whitespace around that final line are ignored; punctuated tokens are ordinary text. Pending tool media, such as generated TTS audio, still delivers after the silent model text is removed.

The terminal producer prepares the reply once and records whether it is visible or silent. Delivery and clients consume that fact and the full prepared payload without interpreting the text again; an explicit visible fact stays visible even when its text is `NO_REPLY`. `NO_REPLY.`, `"NO_REPLY"`, `{"action":"NO_REPLY"}`, and tokens attached to or trailing ordinary prose on the same line are visible text, not silent endings. Stored assistant history uses existing display and final-result facts first, then the same exact check on raw assistant text; user text is never treated as a silence instruction.

Conversation policy still controls admission and default reply expectations:

- Direct and accepted group/channel requests normally receive answers. An explicit token-only `NO_REPLY` can end either silently.
- Mention and access gates still decide which messages reach the agent. `silentReply.group: "allow"` permits optional handling of unaddressed group requests; it is not needed to honor an explicit `NO_REPLY`.
- [Ambient room events](/channels/ambient-room-events) can remain silent. In `message_tool` visible-reply mode, visible output uses `message(action=send)`. Private subagent completions record the parent's reviewed outcome internally.

Defaults live under `agents.defaults.silentReply.group`; `surfaces.<id>.silentReply.group` can override group policy per surface. Doctor removes the retired `internal` setting during config migration.

Generic internal runner failures stay quiet for optional turns that have not shown visible output, including groups explicitly configured to allow silence. Required turns still receive an error. Classified recovery guidance, such as missing-auth, rate-limit, or overload notices, remains deliverable, and visible progress receives a failure outcome rather than being left unfinished. Direct chats show compact failure copy by default; raw runner details show only when `/verbose full` is enabled.

Optional turns owe no result: an empty final ends quietly without recovery or notice, and remains classified as empty rather than `NO_REPLY`. Model fallback skips an empty result only when the completed turn is explicitly optional; an empty result without that policy still needs recovery.

When a result is owed, an empty final is not intentional silence. OpenClaw keeps its bounded recovery path without repeating completed actions. If recovery still returns no answer, the run fails. An admitted user request receives at most one short system notice: "No answer was returned. Ask again if you still need one." When model fallback is available, that notice appears only after the fallback chain is exhausted, not once per candidate. It is not saved or classified as an assistant answer. Heartbeat, cron, and other background or internal failures remain recorded without posting a missing-answer notice to chat. Existing classified failure guidance and alert paths still apply; a silent recovery cannot turn a provider failure into success. Confirmed delivery or still-owned delivery prevents duplicate recovery; see [Reply shaping](/concepts/agent-loop#reply-shaping).

Pending work without an authored acknowledgment retains its existing waiting status so supported channels can keep the live progress card until the result arrives. An explicit `NO_REPLY` still ends silently without canceling that work. Failed delegated tasks use the same short missing-answer copy; their existing delivery and requester-history mirroring are unchanged.

Pending WebChat and Control UI work retains progress cards and waiting status while a result is still owed.

## Related

- [Channel inbound API](/plugins/sdk-channel-inbound) - receive orchestration and acknowledgment policy
- [Channel outbound API](/plugins/sdk-channel-outbound) - durable sends and delivery receipts
- [Streaming](/concepts/streaming) - real-time message delivery
- [Retry](/concepts/retry) - message delivery retry behavior
- [Queue](/concepts/queue) - message processing queue
- [Channels](/channels) - messaging platform integrations
