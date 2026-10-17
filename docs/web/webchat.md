---
summary: "Native and Control UI WebChat usage over the Gateway WebSocket"
read_when:
  - Debugging or configuring WebChat access
  - Understanding human mention delivery and retry behavior
title: "WebChat"
---

Status: the macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket. No embedded browser, no local static server.

## What it is

- A native chat UI for the gateway.
- Uses the same sessions and routing rules as other channels.
- Replies always go back to WebChat.
- History is always fetched from the gateway (no local file watching). If the gateway is unreachable, WebChat is read-only.

## Quick start

1. Start the gateway.
2. Open the WebChat UI (macOS/iOS app) or the Control UI chat tab.
3. Configure a valid gateway auth path (shared-secret by default, even on loopback). See [Auth basics (local vs remote)](/web/dashboard#auth-basics-local-vs-remote).

## How it works

- The UI connects to the Gateway WebSocket and uses the `chat.history`, `chat.send`, `chat.inject`, and `chat.message.get` RPC methods.
- Control UI opens a chat with a small recent-history page through `chat.startup`. Short chat links resolve their session in that same request. Short-reference startup also subscribes the connection to authorized session events before reading history, so updates arriving before the chat pane mounts are not missed. Scroll upward to load older messages. A restored Home pane waits for the selected chat to finish loading, while explicitly opening Home loads it immediately.
- Startup metadata contains commands, swarm availability, and required worker policy. The model picker loads its catalog and account selection through `models.list`; `chat.startup` does not duplicate them. Session model and runtime details remain in `sessionInfo` and `defaults`.
- Clients retaining the command catalog can send its `stateRevision.commands` as `knownState.commands` on later `chat.startup` requests. Matching revisions omit `metadata.commands`; other metadata stays current. Cold clients and changed catalogs receive the full list. The revision comes from the same prepared command owner as compact `chat.metadata`, including config, plugin, and skill invalidation.
- `chat.history` is bounded for stability: Gateway may truncate long text fields, omit heavy metadata, and replace oversized entries with `[chat.history omitted: message too large]`. History pages skip hidden and tool-only transcript entries while filling the requested visible-message window from the existing indexed transcript. A byte-full window can finish before the requested message count, with older content available through pagination. API clients can send a per-request `maxChars` to override the default limit for one call.
- Paginated `chat.history` and `chat.startup` requests accept a `maxBytes` page target, defaulting to 512 KiB with a 6 MiB hard ceiling for messages and their activity. The Control UI requests up to 80 messages within 256 KiB for the initial tail, then up to 1,000 older messages within 1 MiB and follows `nextOffset` to continue. Messages and indivisible groups projected from one transcript row that exceed the page budget use fetchable references rather than exceeding the budget. Anchored `messageId` reads retain the same default page budget. Bound Claude CLI transcripts use the same page budget and back-scroll pagination, including messages that exist only in the native transcript.
- If history changes during a page read, the Gateway returns a coherent page from the current history. A `windowReset: true` response contains a replacement tail; clients replace their loaded history and continue with its `deltaCursor` and pagination fields. A stale delta cursor returns `{ kind: "reset" }`, prompting a fresh tail request. Reads racing a projection rebuild wait briefly before returning a retryable rebuilding error.
- Board session summaries keep their latest 20 messages and use cursor catch-up for updates. Event bursts share a refresh after four to five seconds, with at least five seconds between automatic reads; opening a summary or retrying loads immediately. Hidden summaries catch up when shown again. Cursor reads honor the same `maxChars` and `toolResultMaxChars` preview limits as tail pages.
- When a visible assistant message was truncated in `chat.history`, the Control UI automatically fetches the full display-normalized entry through `chat.message.get`. That fetch does not increase the default history payload. The preview remains visible while it loads. Recovered content replaces it inline. `chat.message.get` uses the same transcript branch and display rules as `chat.history`. Unlike `chat.history`, it targets one entry by `messageId`. It returns an honest unavailable reason when the full content can no longer be returned.
- `chat.history` follows the active transcript branch for append-only session files, so abandoned rewrite branches and superseded prompt copies are not rendered in WebChat.
- Compaction entries render as a history divider showing the context reduction when token measurements are available. Ordinary conversation history and Fork remain available; compaction does not create a separate checkpoint browsing or restoration surface.
- Control UI remembers the backing Gateway `sessionId` returned by `chat.history`. It includes that id on follow-up `chat.send` calls. Reconnects and page refreshes therefore continue the same stored conversation, unless the user starts or resets a session.
- Restart-recovered WebChat turns retain their current conversation as the message tool's reply destination, including turns started by CLI/RPC operator clients through `sessions.send` or `chat.send`. Progress sends without an explicit target continue to appear in that session. For an internal recovery without an external delivery context, an external-channel session key does not authorize sending to that channel.
- Foreground sends also include the displayed branch's leaf from the rendered history as `expectedLeafEntryId`. If another client switched branches first, Control UI parks the message for review and refreshes the transcript instead of posting it to the new branch. Reconnect and restored-outbox replays intentionally omit this precondition after reconciling current history.
- When you change a chat setting and immediately send, Control UI shows **Applying chat settings** until that change and its session refresh finish. Later background session refreshes do not extend this wait. Opening a pane without changing a setting does not create a settings wait.
- `chat.send` takes a key that prevents duplicate requests (Control UI uses the run id). The Gateway dedupes repeated requests that reuse the same key. Retried or duplicate in-flight submits do not create a second run when the session, message, attachments, and mention selections match. Reusing that key with different mention selections is rejected.
- Queued messages keep their original send identity even when execution starts under a different run id. Clients reconcile the local pending message with its saved transcript entry by that send identity, so completion and history reload show one copy.
- During reconnect, an attempted message whose delivery is uncertain stays in the transcript with a **Waiting for reconnect** status. Messages that have not been attempted stay in the composer queue. Messages the Gateway has queued for a later turn also appear above the composer until consumed or canceled, without a duplicate transcript bubble or another send. Their remove action cancels the exact queued message on the Gateway. Once removal is confirmed, that prompt and its attachments disappear from the queue and conversation, including after reconnect or reload. Stop, timeout, and unsuccessful-send cancellations keep their recovery messages visible. Reordering applies only to messages still owned by the browser. **Discard** on an uncertain local message removes only its browser copy; it does not cancel a message the Gateway already received.
- Replying to a specific message (right-click → Reply) sends the target's transcript id as `replyToId` on `chat.send`. For sources with visible text, the Gateway resolves that message from session history. It hydrates the same channel-agnostic reply context metadata Discord replies use. Agents see `has_reply_context` plus the untrusted "Reply target of current user message" block with sender label and body. Webchat prompts keep volatile conversation ids such as `reply_to_id` suppressed, per the existing byte-stable prompt policy for direct webchat sessions. Reply targets without a persisted transcript id (for example pending sends) fall back to an inline quote in the message body.
- History pages include bounded quoted-reply previews, so displaying references does not fetch each original separately. `chat.message.get` reads the selected indexed row, with preceding-row context only when needed to hide an old announce pair. Explicit full-message reads are cached across reconnects within the same session lifecycle; reset or replacement invalidates them.
- Attachment-only messages keep their Reply action. The preview uses filenames or image labels, and `replyToId` still points to the original entry. Replying does not attach the source files to the new message.
- Workspace startup files and pending `BOOTSTRAP.md` instructions are supplied through the agent system prompt's `# Project Context` section, not copied into the WebChat user message. If bootstrap content is truncated, the system prompt gets a short "Bootstrap Context Notice" instead. Detailed counts and config knobs stay on diagnostic surfaces.
- Gateway display normalization on `chat.history` strips runtime-only OpenClaw context, inbound envelope wrappers, inline delivery directive tags such as `[[reply_to_current]]`, `[[reply_to:<id>]]`, and `[[audio_as_voice]]`, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, including truncated blocks), and leaked ASCII/full-width model control tokens. Removing model control tokens preserves punctuation and Markdown formatting, keeps adjacent words separated, and leaves code examples intact. Stored assistant visibility honors display, phase, and final-source facts first, then omits raw assistant text that trims to uppercase `NO_REPLY`; lowercase and wrapped forms remain visible. User text is never classified as silence. Clients render prepared history and live output without interpreting silence tokens.
- When a reply attachment cannot be read or prepared, WebChat preserves any deliverable attachments. It shows one short failure warning without exposing local filesystem paths.
- In Control UI chat and new-session composers, oversized static PNG uploads are resized in a browser worker before sending, keeping image decoding and encoding off the composer’s main thread. This applies to drag-and-drop, the file picker, and image paste. Images already within the Gateway-advertised limit stay unchanged; resized images keep their aspect ratio and PNG transparency. Browser resizing is limited to 25 megapixels of source data. Animated PNGs are not flattened, and other file types retain their size limits. If an image cannot be decoded or resized, its attachment shows a read failure instead of sending oversized bytes.
- Control UI attachment failures remain visible beside the composer until removed, including files rejected before reading. Uploaded-photo and managed-image previews are capped at 512 KiB; open or download an image to load the original. A failed same-origin HTTPS preview never falls back to transferring the full image over WebSocket. Animated or unsupported preview formats remain available through explicit original-image actions instead of being silently flattened.
- In the Control UI, assistant images and attachments appear in message order, between their surrounding paragraphs. Before/after labels stay beside the corresponding images.
- Attachment directives owned by the current WebChat reply stay hidden in live transcript events while files are prepared. User prompts, fenced examples, and references outside that reply's attachment pipeline remain unchanged.
- WebChat excludes reasoning-flagged reply payloads (`isReasoning: true`) from assistant content, transcript replay text, and audio content blocks. Thinking-only payloads therefore do not surface as visible assistant messages or playable audio.
- `chat.inject` appends an assistant note directly to the transcript and broadcasts it to the UI (no agent run). When session keys share a transcript, such as a cron base key and its isolated run key, the note is appended under the transcript's owner. The Control UI reconciles each note by transcript identity, so identical notes remain separate and do not become run activity or duplicate after a history reload.
- Aborted runs can keep partial assistant output visible in the UI. Gateway persists that partial text into transcript history when buffered output exists, and marks the entry with abort metadata.

### Transcript and delivery model

Admission and transcript persistence are separate. A `chat.send`, `sessions.send`,
or initial `sessions.create` acknowledgment can arrive while approved input
waits in durable pending-input custody, including during workspace preparation.
Skill-library selection and authoring preparation run after that acknowledgment,
under the admitted run's cancellation and error handling, alongside workspace
and reply startup. Preparation failures appear as run errors. The Gateway reserves the existing
reply-admission ticket before acknowledging, so a later send cannot overtake a
message whose preparation is still pending.
An optional `messageSeq` comes only from a committed transcript receipt. Clients
must not predict it from history length or treat `status: "started"` as persistence.
Chat admission rechecks current committed session access independently of sidebar
refreshes. Durable input custody still checks that authority at the write boundary.
The Control UI replaces its provisional source with accepted custody, then with
the saved transcript row. Accepted inputs stay below saved conversation history until
they are committed to the transcript. Its renderer keeps a loaded local preview in the same image
element during this handoff while saved media metadata and image bytes load.
Authoritative text, media replacements, and removals still win. Unavailable or
access-denied media shows a visible reason.
Once custody, a consumption record, or a committed user-message receipt retires
a local source, replayed terminal events cannot bring it back, even when its row
is absent from a later history page. Submission identity stays separate from the
execution run, so two intentionally identical sends remain two inputs.

WebChat has two separate data paths:

- The SQLite transcript rows are the durable model/runtime transcript. For normal agent runs, the embedded OpenClaw runtime persists model-visible `user`, `assistant`, and `toolResult` messages through the session accessor. WebChat does not write arbitrary delivery, status, or helper text into that transcript.
- Gateway `ReplyPayload` events are the live delivery projection: normalized for WebChat/channel display, block streaming, directive tags, media embedding, TTS/audio flags, and UI fallback behavior. They are not themselves the saved session log.
- Harnesses that require visible replies through `tools.message` still use WebChat as a current-run internal source reply sink. A targetless `message.send` from that active WebChat run is projected into the same chat and mirrored to the session transcript. WebChat does not become a reusable outbound channel and never inherits `lastChannel`.
- A reply already published through its committed transcript row is not repeated in a later `chat` final. The native run lifecycle owns completion, while queued source replies retain their own completion event.
- WebChat injects assistant transcript entries only when the Gateway owns a displayed message outside a normal embedded agent turn. Those cases are `chat.inject`, non-agent command replies, aborted partial output, and WebChat-managed media transcript supplements.
- If live assistant text appears during a run but disappears after history reload, check three things in order. First, whether the SQLite transcript contains the assistant text. Second, whether the `chat.history` display projection stripped it. Third, whether the Control UI optimistic-tail merge replaced local delivery state with the persisted snapshot.

Normal agent-run final answers should be durable because the embedded runtime writes the assistant `message_end`. Any fallback that mirrors a delivered final payload into the transcript must first avoid duplicating an assistant turn that the embedded runtime already wrote.

## Speech

When `tts` is configured, assistant messages offer **Read aloud**. Audio is
synthesized by the Gateway using the configured TTS provider, voice, and endpoint.
**Stop reading** cancels browser playback. Long replies play in ordered chunks
within `tts.maxTextLength`. Starting another Read aloud or Talk action stops the
previous playback. The control does not use browser speech synthesis. The former `messages.tts` configuration is migrated to `tts` by Doctor.

Hold the microphone button for dictation. Explicit audio models in
`tools.media.models` use the same transcription owner as uploaded voice notes,
including local OpenAI-compatible `/v1/audio/transcriptions` endpoints and local
CLI models. Audio is transcribed when capture ends; file-based providers do not
produce partial captions. An explicit Talk transcription provider, matching
`agents.defaults.voiceModel`, or Voice Call streaming configuration keeps the
streaming path. Dictation is unavailable when none of the configured file
providers or CLI commands can run.
Loopback and private-network endpoints use the existing provider opt-in:
`models.providers.<id>.request.allowPrivateNetwork: true`.

Set `talk.realtime.mode: "stt-tts"` for split browser Talk: the Gateway transcribes
each utterance, the current chat session's agent answers it, and the browser plays
the Gateway's generated speech. This uses the configured agent model, including
local models. Output uses `talk.provider` when set, otherwise `tts`.
The browser pauses capture while generating and playing the answer. Stop ends
capture and playback and cancels that call's active chat run. A Talk failure,
including the two-minute answer timeout, ends capture and playback but leaves the
accepted chat run to finish in the conversation. The timeout message tells you to
look for the answer in chat. Leaving the chat or switching away from Talk also
leaves accepted work running. Split Talk requires
both transcription and speech output to be configured. Dictation in an existing
conversation uses that conversation's agent credentials; the catalog remains an
advisory view of the configured Talk agent.

Without these settings, the existing realtime Talk and transcription-provider
selection remain unchanged. Browser microphone capture requires a secure context
(HTTPS or localhost) and microphone permission.

## Human mention delivery

The Control UI binds each [selected person](/concepts/multi-user#mentioning-people) to the submitted message text. `chat.send`, the initial message on `sessions.create`, and `sessions.send` accept an optional `mentions` array of `{ profileId, start, end }` annotations. There are at most ten annotations. `start` is inclusive and `end` is exclusive, measured in UTF-16 code units. The Gateway validates their text ranges and recipients before accepting the input. Plain `@name` text and agent output do not create human mentions. Copying or quoting text does not copy its recipient selections.

The mention becomes eligible for an Inbox entry and optional browser push only after the original human message is newly committed to the transcript. An early `status: "started"` acknowledgment, a staged initial message, or durable pending-input custody is not that commit. A queued or remotely placed first message therefore does not notify while it is still waiting to be recorded. A later agent failure does not undo a mention whose human message was already committed.

Transport retries preserve the exact submitted text, mention annotations, and original send identity, even when execution gets a different run id. Replaying that committed input does not create another mention or restore a dismissed entry. An intentional new send has a new identity and may notify again, even when its text is identical. Transcript loading, hidden continuations, and attachment enrichment are not new human sends.

The supporting RPCs require `operator.read` and use the authenticated profile, never a caller-selected Inbox owner:

| Method or event     | Contract                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users.mentionable` | Search with `{ sessionKey, agentId?, query? }`, or use `{ agentId, visibility?, query? }` before creating a session. Returns bounded `{ users, truncated }` results with profile id, display name, optional avatar URL, and online status. |
| `mentions.list`     | Call with `{}` to fetch your current `{ gatewayInstanceId, revision, items }` snapshot.                                                                                                                                                    |
| `mentions.dismiss`  | Pass `{ ids }` containing up to 100 distinct visible entry ids. Returns the same snapshot shape after dismissal.                                                                                                                           |
| `mentions.changed`  | Targeted `{ gatewayInstanceId, revision }` invalidation. Fetch `mentions.list` again. Revisions describe that connection's authorized view, not global Gateway activity.                                                                   |

Delivery is best-effort. The Inbox and replay bookkeeping survive Gateway restarts within their retention limits. Capacity limits can still skip alerts. Restarting or reconnecting does not resend old browser notifications or restore dismissed entries. Notification failures do not retry or undo the posted chat message. Browser push does not provide exactly-once delivery. See [Inbox retention](/concepts/multi-user#temporary-mentions-inbox) and [notification preferences](/web/notifications#receive-human-mention-alerts).

Dismissing an unknown or already dismissed entry is harmless and returns the current Inbox snapshot. If an Inbox request returns an `UNAVAILABLE` error, the Control UI retries with increasing delays and respects the Gateway’s minimum retry delay. Ordinary connection updates and mention events do not bypass that backoff.

Background Inbox refresh failures retry after one minute, doubling the delay up to fifteen minutes until a refresh succeeds. Session and profile updates respect the pending background retry; explicit Inbox reads can still retry immediately. The `gateway/mentions` warning records the failing phase, source, error class and code, cause, elapsed time, and next retry delay.

## Control UI agents tools panel

- The Control UI `/agents` Tools panel has a "Tool preview" backed by `tools.effective(sessionKey=...)`. It previews core, plugin, channel-owned, and already-discovered MCP server tools using the session's saved settings. It does not report the exact tools of an active run.
- A separate config-editing view (backed by `tools.catalog`) covers profiles, per-agent overrides, and catalog semantics.
- The preview is session-scoped. Switching sessions on the same agent can change it, and resetting a session refreshes it. Unsaved config edits are not reflected in the preview, and saved or runtime changes may take time to appear. Run-specific tools can become available when a run starts; a tool missing from the preview is not necessarily disabled. The run still applies its current policy, credentials, and execution checks.
- The panel shows a notice when configured MCP servers have not been connected or changed since the last discovery. It does not silently start MCP transports from the read path. Loading and failed previews do not mean the session has zero tools.
- The config editor does not imply runtime availability. Effective access still follows policy precedence (`allow`/`deny`, per-agent and provider/channel overrides).

## Remote use

- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.
- You do not need to run a separate WebChat server.

## Configuration reference (WebChat)

Full configuration: [Configuration](/gateway/configuration)

WebChat has no persisted config section. Gateway uses the built-in `chat.history` display limit. API clients can send per-request `maxChars` to override it for a single call. Clients that can expand tool output with `chat.message.get` may also send `toolResultMaxChars` to request shorter tool-result text previews without reducing user or assistant text. Complete JSON objects and arrays that fit the existing display limit retain that limit because clients use them for source cards and embedded views. This optional limit applies to `chat.history` and `chat.startup`, including history pages and delta catch-up; omit it to retain the default behavior. Repeat it on each page request. Legacy `channels.webchat` and `gateway.webchat` config is retired. Run `openclaw doctor --fix` to remove it.

Related global options:

- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`:
  shared-secret WebSocket auth.
- `gateway.auth.allowTailscale`: browser Control UI chat tab can use Tailscale
  Serve identity headers when enabled.
- `gateway.auth.mode: "trusted-proxy"`: reverse-proxy auth for browser clients behind an identity-aware **non-loopback** proxy source (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.
- `session.*`: session routing and storage.

## Related

- [Control UI](/web/control-ui)
- [Dashboard](/web/dashboard)
