# Slack feature recipes

Copy `qa/scenarios/channels/slack-e2e-lifecycle.yaml` when composing a new proof.
Keep the existing `scenario` / `flow` schema and `call`, `ref`, `expr`, `assert`,
and `try/finally` vocabulary. `channelE2e` is the shared native fixture interface,
not a second runner or a model tool.

## Native operations

| Method                                                             | Recipe and evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor()`                                                         | Same-lease identity/channel/Gateway readiness; capability matrix and advertised-scope diagnostics. It does not post a test message.                                                                                                                                                    |
| `send({text, mention, threadId, replyToMessageId})`                | Mentions the SUT by default. `mention:false` sends literal text without adding a mention. Save the returned native ID. `read({messageId:id})` proves storage.                                                                                                                          |
| `read({messageId, threadId, limit, before, after})`                | Reads Slack stored state; before/after are native timestamp bounds. Cursor pagination is internal, up to `limit` (1–1000, default 50). Supply the root `threadId` when reading a threaded message. Read-only observation does not confer mutation ownership.                           |
| `edit({messageId,text,threadId})` / `delete({messageId,threadId})` | Only exact live receipts owned by this run, using the original author. Read back the same ID to prove new text or absence; an accepted write alone is weaker evidence.                                                                                                                 |
| `react({messageId,emoji,remove,threadId})`                         | Use a Slack reaction name such as `eyes`, optionally colon-wrapped. Removal requires this run's add receipt. The helper checks `reactions.get` for the driver's stored presence/absence. Glyph normalization belongs to the existing model-tool scenario, not this native fixture API. |
| `thread({name,messageId,text})`                                    | Slack threads are root message timestamps, not independently named channels. With an owned message, returns its root; otherwise creates a quiet root using `text ?? name`. Only owned roots/replies are valid mutation destinations.                                                   |
| `upload({path,fileName,text,mention,threadId})`                    | Uploads one local synthetic file. Checks `files.info`, its share in the leased channel, and stored message/file ID/filename. Returns media identity, not downloaded-byte equality or visual proof.                                                                                     |
| `waitForReply({afterMessageId,threadId,textIncludes,timeoutMs})`   | Waits for a stored SUT reply after owned ingress. Use a unique marker and explicit root for strongest correlation. A top-level reply also requires a marker and the exact Gateway capture receipt. Default timeout is 60 seconds.                                                      |

`mention:false` is quiet **ingress**, not a promise that Slack policy will suppress
replies: an active thread may implicitly address the bot. Test mention gating in
a new top-level fixture and observe a bounded window, as the lifecycle YAML does.
Use `channelE2e.signal` / `assertActive()` around custom asynchronous work; all
native helper calls guard lease, cancellation, and stopped state.

## Gateway/model versus fixture actions

The lifecycle's thread request enters Slack, reaches the real Gateway, invokes the
selected model lane, and returns a stored SUT reply. Its edits, reactions, and
uploads are native fixture actions. They are not evidence the model selected or
invoked a message tool.

For an actual model action, start from the relevant existing scenario listed by
`--list-scenarios`, such as `slack-reaction-glyph-native`, chart/table presentation,
or native approvals. Read its `execution.summary` and constraints before running.
Use its existing Gateway/flow module owner and inspect the model/tool transcript
as well as native readback. Select `--provider-mode live-frontier` only when the
requested proof needs a real provider; use existing authorized provider config
rather than embedding a model identity in a recipe.

Gateway RPCs remain available as `env.gateway.call(...)`. A direct `send` or
`message.action` RPC proves Gateway/plugin behavior, **not model tool invocation**.
Keep that distinction in assertions and the final report. Existing advanced
module flows remain reachable through `slackScenarioContext`; their lifecycle
and cleanup contracts remain module-owned. Direct raw-client calls bypass the
new driver's receipt ledger, so prefer `channelE2e` for new native fixtures.

## Native write capture

`slackScenarioContext.readNativeWrites()` returns safe Gateway mutation summaries
from the existing debug-proxy owner: post/update/delete, reaction add/remove,
upload completion, and file deletion. Entries include request-event IDs plus
native message/thread/file IDs where available. Filter `evidence: "api-accepted"`
when asserting acceptance. Unanswered requests, transport/server errors,
potentially partial failures, and undecodable responses remain `uncertain`, with
a fixed diagnostic reason and no raw SDK error.
Definitive Slack rejections and read-only calls are excluded. Missing capture is
not proof of absence; capture is bounded and only observes traffic through that Gateway.
Use the existing `getMessageWriteCursor` / `readMessageWrites(cursor)` pair for
transient post/update text and Block Kit observations used by progress recipes.
No second Socket Mode client is needed or allowed for this proof.

## Existing app capabilities

Both leased bots must already belong to the dedicated channel. History uses
`channels:history` for public or `groups:history` for private channels. The driver
needs `chat:write` for send/edit/delete, `reactions:write` plus `reactions:read` for
reaction verification, and `files:write` plus `files:read` for upload/readback and
cleanup. The SUT needs its existing Slack Gateway/event configuration,
`chat:write`, history access, and `files:read` for media observation; SUT-originated
file fixtures additionally need its existing `files:write`. Thread history can
be unavailable to a particular token/conversation; report Slack's exact error
and actor rather than silently changing token type.

The SUT app-level token needs `connections:write`; the existing app subscriptions
must deliver message/app-mention events. Reaction-event ingestion is a separate
capability from native API reaction proof and needs the relevant existing SUT
subscriptions/scopes. Older QA Driver manifests omit file/reaction scopes.
`missing_scope`, `not_in_channel`, `not_allowed_token_type`, and disabled app
features are pool-owner prerequisites. QA must not alter apps, broker payloads,
permissions, or tokens to manufacture a pass.
