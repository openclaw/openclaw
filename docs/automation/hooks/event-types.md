---
summary: "Every internal event key, its trigger and wait behavior, and the context each producer supplies"
read_when:
  - You are choosing which event key a handler should subscribe to
  - You need the trigger and wait behavior of a specific event
  - You need the context fields a producer supplies to your handler
title: "Hook event types and context"
---

Every internal event key, its trigger and wait behavior, and the context each producer supplies. Part of the [Hooks](/automation/hooks) guide.

## Event types

Subscribe to an exact key below or a bare family (`command`, `session`, `agent`,
`gateway`, `message`). Family subscriptions receive all actions in that family.
Do not subscribe the same handler to both `command` and `command:new` unless you
want it called twice for a new command. `session:compact` is not a family or a
wildcard; subscribe to the two exact compaction keys.

| Event                    | Trigger and wait behavior                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `command:new`            | Authorized new-session command handling, or a Gateway session operation that emits new-command hooks; awaited.            |
| `command:reset`          | Authorized reset-command handling or Gateway session reset; awaited.                                                      |
| `command:stop`           | Stop-command handling after the abort request; awaited, with no hook reply delivery.                                      |
| `session:auto-reset`     | Existing session replaced due to daily/idle policy; dispatched independently of the successor turn.                       |
| `session:compact:before` | Before compaction work; awaited.                                                                                          |
| `session:compact:after`  | After successful compaction; awaited.                                                                                     |
| `session:patch`          | An authorized Gateway patch is applied, or a supported model-selection path persists a change; asynchronous notification. |
| `agent:bootstrap`        | Workspace bootstrap resolution before context injection; awaited.                                                         |
| `gateway:startup`        | Scheduled after hook loading and sidecar/channel startup work; does not delay initial Gateway bind.                       |
| `gateway:shutdown`       | Shutdown begins, before channel/plugin teardown; bounded wait.                                                            |
| `gateway:pre-restart`    | Shutdown has a finite expected-restart delay; bounded wait.                                                               |
| `message:received`       | Accepted inbound dispatch with a session key; asynchronous observation.                                                   |
| `message:transcribed`    | Pre-agent preprocessing has nonempty audio transcript text and a session key; asynchronous observation.                   |
| `message:preprocessed`   | Media/link preprocessing completed or was skipped, with a session key; asynchronous observation.                          |
| `message:sent`           | A delivery owner reports a send outcome with a session key; asynchronous observation. Inspect `context.success`.          |

The initial wait for `gateway:shutdown` and `gateway:pre-restart` hooks is bounded
so independent teardown can proceed. A timeout does not cancel the handler.
Before closing shared state, the Gateway joins the actual hook completion;
a handler that never settles can therefore prevent in-process shutdown from finishing.

Not every incoming transport update or attempted low-level send produces an
internal message event. Suppressed/duplicate inbound dispatches and paths with
no session key can omit them. These are observation points, not a complete
transport audit or a way to block message processing. Fast native-command paths
can skip preprocessing events. `preprocessed` means that phase was passed, not
that every attachment or link was successfully understood. Likewise, compaction
can skip or fail after its before event, and retries can emit before again.

Unknown subscriptions such as `command:nwe` are still registered, but the loader
warns and `hooks info` reports them. Core does not emit them. A custom key only
fires if custom code explicitly emits it; declaring it in metadata does not
create a trigger.

`command:stop` observes cancellation command handling. It is not a natural
agent-finalization gate. For that contract, see `before_agent_finalize` in
[Plugin hooks](/plugins/hooks).

### Event context highlights

Fields below describe the producer payloads. Values marked optional may be
absent; do not assume fields from one event exist on another.

**`command:new` and `command:reset`:** `agentId`, `sessionEntry`,
`previousSessionEntry`, `commandSource`, `senderId`, `workspaceDir`, `storePath`,
and `cfg` on the chat command path. Entries and routing metadata depend on the
caller. Gateway reset uses `commandSource: "gateway:sessions.reset"`; Gateway
agent reset uses `gateway:agent`, and session creation can use `webchat`.
Gateway callers omit `senderId`. Session creation emits new-command hooks only
when requested with `emitCommandHooks` for an existing parent. Prefer
`previousSessionEntry` for the session being replaced: chat and Gateway paths
emit at different points in reset, so this is not a universal pre-reset or
successful-reset receipt.
A `sessionFile` value can be a transcript identifier rather than a readable file
path; do not assume it is JSONL on disk.

**`command:stop`:** optional `sessionEntry`, `sessionId`, `commandSource`, and
`senderId`. It does not carry the full new/reset context.

**`session:auto-reset`:** `cfg`, `agentId`, `workspaceDir`, `storePath`,
`sessionEntry` identifying the ended `sessionId` and optional `sessionFile`,
`reason` (`daily` or `idle`), and optional `transcriptArchived`, `nextSessionId`,
and `nextSessionKey`.

**`agent:bootstrap`:** `workspaceDir`, mutable `bootstrapFiles`, and optional
`cfg`, `sessionKey`, `sessionId`, `agentId`. Each bootstrap record has `name`,
`path`, `missing`, and optional `content`. A handler can replace or extend the
array, but final path deduplication, session/privacy filtering, and context
budgets still apply.

**`session:patch`:** cloned post-operation `sessionEntry`, request-shaped `patch`,
and `cfg`. The patch contains target/expectation fields and submitted settings,
not a computed changed-fields diff. Successful Gateway patches can emit even
when a submitted value was already present. Supported model-selection paths
also emit, including `/model`, the model picker, and model changes through
`session_status`; a read-only status query does not. This is not a notification
for every session-store write.

**Compaction:** both phases include `sessionId`, `missingSessionKey`,
`messageCount`, and optional `tokenCount`. Before also includes
`messageCountOriginal` and optional `tokenCountOriginal`. After includes
`compactedCount` and optional `summaryLength`, `tokensBefore`, `tokensAfter`, and
`firstKeptEntryId`. Do not infer unavailable token counts as zero.

**`gateway:startup`:** `cfg`, `deps`, and `workspaceDir`. **Shutdown and
pre-restart:** `reason` and `restartExpectedMs` (null when no restart is expected
on shutdown). The shutdown wait defaults to 5 seconds; pre-restart adds a
separate 10-second budget. These bound the caller's wait, not the handler's work:
timeout does not cancel promises. Channels have not yet been torn down, but
neither queued agent work nor message delivery is guaranteed to finish before
shutdown. Typed `session_end` drain behavior belongs to [Plugin hooks](/plugins/hooks).

#### Message context

`message:received` contains `from`, `content`, `channelId`, and optional
`timestamp`, `accountId`, `conversationId`, `messageId`, `media`, `originalMedia`,
`mediaStagingPending`, and `metadata`. Content prefers a nonblank command body,
then raw body, then generic body. It does not select `BodyForAgent`; the fallback
body is surface-defined rather than stripped of all enrichment by the mapper.

Received `metadata` can contain `to`, `provider`, `surface`, `threadId`,
`senderId`, `senderName`, `senderUsername`, `senderE164`, `guildId`, `channelName`,
and `topicName`. Legacy attachment aliases are `mediaPath`, `mediaUrl`,
`mediaType`, `mediaPaths`, `mediaUrls`, and `mediaTypes`; remote-staging metadata
can also include `mediaRemoteHost`, `mediaStagingPending`, and corresponding
`originalMediaPath`, `originalMediaUrl`, `originalMediaType`, `originalMediaPaths`,
`originalMediaUrls`, and `originalMediaTypes`. Prefer the structured media arrays.

`message:transcribed` and `message:preprocessed` contain `channelId`, `cfg`, and
optional `from`, `to`, `body`, `bodyForAgent`, `timestamp`, `conversationId`,
`messageId`, `senderId`, `senderName`, `senderUsername`, `provider`, `surface`,
and the structured media fields. Transcribed adds required `transcript` text;
preprocessed adds optional `transcript`, `isGroup`, and `groupId`.
`bodyForAgent` is the enriched body prepared for the agent. `mediaPath` and
`mediaType` remain deprecated first-attachment aliases. These contexts do not
promise `accountId` or the received event's `metadata` object.

Each structured media fact can contain `path`, `url`, `contentType`, `kind`,
`transcribed`, `messageId`, and `workspaceDir`. Facts preserve source order.
When `mediaStagingPending` is true, `media` is withheld and `originalMedia`
describes the original attachments; do not treat remote paths as local files.

`message:sent` contains `to`, `content`, `success`, `channelId`, and optional
`error`, `accountId`, `conversationId`, `messageId`, `isGroup`, and `groupId`.
`success: false` reports failure on a path that emitted an outcome; absence of
an event is not proof of either success or failure. Outbound delivery can report
one outcome per logical payload rather than per text chunk, and a partial
failure can include a message ID for a part already sent. Durable outbound
queue settlement can defer the observation; it does not make the hook durable.
Do not blindly resend on failure: you can duplicate a delivered part. A send
result is not proof that the recipient read the message.
