---
summary: "Session list bootstrap, the common event families, and the node helper and exec lifecycle contracts"
read_when:
  - Bootstrapping a session list in one subscribe call
  - Subscribing to a gateway event family
  - Implementing node helper methods or exec lifecycle handling
title: "Gateway protocol session bootstrap and events"
sidebarTitle: "Bootstrap and events"
doc-schema-version: 1
---

How a client bootstraps a session list in one call, the common gateway event families, and the node helper and exec lifecycle contracts.

## Session list bootstrap

Call `sessions.subscribe` with a non-empty `sessions.list` parameter object, such
as `{ limit: 60, ownerFirst: true }`, to subscribe and load the initial roster in
one request. A successful WebSocket response has the payload
`{ subscribed: true, list }`, where `list` is the normal `SessionsListResult`.
Calling with `{}` preserves the acknowledgment-only response
`{ subscribed: true }` and does not read a snapshot.
List parameters select the snapshot; they do not filter the connection's session
event subscription.

The Gateway registers the subscription before projecting the list. Clients must
listen for `sessions.changed` before making the request: events can arrive while
the snapshot is being built. Reconcile those events with the response and issue
a trailing `sessions.list` refresh when needed, including when an event only
invalidates the cached list. Reconnects require a new subscription and snapshot.

The Gateway keeps durable session metadata in memory and fills materialized rows
incrementally. Committed owner changes refresh affected rows; there is no
completed-page cache or one-second staleness window. Keyed descriptions,
resolution, and chat startup prepare their requested row without waiting for the
bulk refresh. Newly admitted or replaced stores load their metadata once, and
rows disappear when their store leaves the current topology. Each response
applies the current viewer's visibility and current activity time.

Resident rows use stored titles and usage. Optional message previews and terminal
fallback-model metadata fill in through bounded read-only background transcript
reads; they can be absent from an early response. Foreground requests take priority.
These reads do not restore cold archives, parse oversized messages, call a model,
or change stored metadata or session activity ordering. Missing historical titles
and legacy ACP keys are repaired only by `openclaw doctor --fix`. Missing usage
remains absent until the normal usage writer records it.

Both methods accept `activeOnly: true` to select currently running or queued sessions before pagination. Activity comes from the live runtime owners, not a stored status flag. Ordinary listing behavior is unchanged when the option is omitted or false. Active-only results include each visible agent-owned `global` and `unknown` session with its raw key and captured `agentId`; callers identify rows by agent, key, and `sessionId` together. Literal `agent:<id>:global` and `agent:<id>:unknown` sessions remain different rows. Active-only raw sentinel rows omit the optional `childSessions` and `hasActiveSubagentRun` fields; use `hasActiveRun` for direct activity. Normal permissions, archive/inclusion filters, and page limits still apply. Sessionless/internal runs are outside the session index.

Both methods accept `ownerFirst: true` to prepend up to 60 matching viewer-owned
rows (or `limit`, when smaller) to the normal first page, deduplicated by session key. This applies only
when `offset` is zero or omitted; later pages use normal pagination. Owned rows
must pass the same visibility and list filters as the shared page. The Gateway
resolves the viewer from the authenticated connection; no client-supplied
identity selects these rows. Without an authenticated viewer identity, or when
`ownerFirst` is false or omitted, the list uses normal ordering.

The shared page still determines `limitApplied`, `offset`, `nextOffset`,
`hasMore`, and `totalCount`. Prepended rows can make `sessions.length` and `count`
exceed the shared page size. Use `nextOffset` to advance and deduplicate rows by
session key across pages; do not derive the next offset from the displayed row
count.

## Common event families

- `chat`: UI chat updates such as `chat.inject` and other transcript-only chat
  events. In protocol v4, delta payloads carry `deltaText`; `message` remains
  the cumulative assistant snapshot. Non-prefix replacements set
  `replace=true` and use `deltaText` as the replacement text.
  Failed runs (`state: "error"`) may include `errorDetail` alongside the coarse
  `errorKind` and human-readable `errorMessage`. This closed object has seven
  optional fields: `provider`, `model`, `failoverReason`,
  `providerRuntimeFailureKind`, `providerErrorType`, `httpStatus`, and
  `providerErrorMessagePreview`. Strings are capped at 300 characters; `httpStatus`
  is an integer from 100 through 599. Details come from the failed attempt's
  sanitized provider observation, not from reparsing the user-facing message.
  The preview is credential-redacted and may be shorter than the protocol cap.
  Raw bodies, raw previews, and diagnostic hashes are never included in
  `errorDetail`. Runs without provider observations omit it; successful and
  canceled events do not carry it. This is an additive protocol-v4 field.
- `session.message`, `session.operation`, `session.tool`: transcript, in-flight
  session operation, and event-stream updates for a subscribed session.
- `session.approval`: sanitized pending and terminal approval truth for an
  explicitly opted-in exact-session subscriber. Child approvals use the
  persisted ancestor audience; events never mutate transcripts or wake agents.
- `session.observer`: safe live session headline and status digest. A model-authored
  preamble can update the headline immediately; utility-model assessments replace
  it later when available. Web, iOS, and Android use the same run-scoped digest.
  The optional `sessionId` and opaque `lifecycleRevision` identify the session
  lifecycle; `lifecycleRevision` can be absent before the first reset. Revisions
  increase across runs within that lifecycle but can restart after a reset.
  `/clear` preserves `sessionId` and changes `lifecycleRevision`.
  Clients show its headline or inspector link only while the digest's exact `runId`
  is present in `activeRunIds`.
- `sessions.changed`: session index or metadata changed. Keyed changes carry the
  affected row in `session`, presented for that connection. Nested rows in
  `sessions.changed` and `session.message` use the same full prepared metadata,
  viewer permissions, and clock as `sessions.list` with title, last-message,
  and activity-summary enrichment enabled. This adds catalog-backed fields such
  as thinking options and replaces legacy model aliases with canonical model IDs
  in event rows. The Control UI applies these rows locally to existing roster
  members, so their values match the list. A `reason: "patch"` event that commits a
  model, account, or runtime selection also carries `catalogChanged: true`; clients
  may treat other patches as session-only and keep cached catalogs. Top-level lifecycle and capacity fields
  remain event receipts, including explicit clearing values. When a nested row
  omits an optional field, honor its top-level clearing tombstone; nested values
  take precedence when present. Merge an existing
  roster member's snapshot locally when the query's membership and pagination
  window remain valid. The Control UI reuses lifecycle and ordinary `patch`,
  `placement`, `send`, `steer`, `agent.run.started`, `agent.input.settled`, `run-capacity`, and
  `chat.title` snapshots for held rows with unchanged identity, archive,
  pin, owner, and parent facts and nondecreasing recency. Keyed `sessions.changed`
  and `session.message` publications also carry `ancestorSessions`, an array of
  full rows for the affected navigation, control, requester, and swarm ancestors,
  and may carry `ancestorSessionRefs` for unchanged ancestor presentations already
  delivered on that connection. References never appear inside `ancestorSessions`.
  The projection walks existing parent references up to the roots,
  deduplicates physical row identities, and stops cycles. Each ancestor passes
  the same per-viewer visibility filter and presentation as `sessions.list`;
  invisible intermediates do not prevent delivery of visible ancestors above them.
  The two arrays together contain at most 64 ancestors. If an ancestor cannot be
  resolved or the traversal exceeds that bound, both fields are omitted so clients
  retain authoritative refresh behavior. The presence of `ancestorSessions`
  certifies complete visible ancestor coverage across both arrays; an empty array
  certifies no visible ancestors only when `ancestorSessionRefs` is also absent or
  empty. These are additive protocol-v4 fields; they do not change subscription
  scope or list membership and require no capability negotiation.
  Full ancestor rows carry an opaque `ancestorRevision`; each reference contains
  `key`, `revision`, and `snapshotAt`, with `sessionId` and `agentId` when present
  on the full row. Before adding the revision tag, the Gateway compares the exact
  connection-specific presented row, excluding only `snapshotAt`. A reference
  certifies that the presentation identified by `revision` remains unchanged.
  Clients retain a referenced row only when they still hold that exact admitted
  presentation with matching identity, then advance its clock without changing
  its other facts. The Control UI binds the revision to the immutable admitted
  row only after confirming that its facts match the full presented row. A list
  replacement or local row change loses that proof, even if its sampling clock
  happens to match. Missing rows, generation or revision mismatches, and uncertain
  presentation ownership require the existing authoritative refresh path.
  The Gateway bounds this per-connection record and sends full rows after first
  delivery, reconnect, resubscribe, reset/delete, changed presentation or visibility,
  eviction, or uncertain delivery. Unsubscribe and disconnect clear the record;
  session deletion invalidates remembered ancestors.
  Older web clients ignore the additive reference field. Because `ancestorSessions`
  contains full rows only, they cannot apply a reference as a partial row and erase
  held fields. Missing ancestor snapshots cause their existing authoritative
  `sessions.list` refresh. Bundled same-origin Control UI build admission prevents
  version skew; custom roots, development UIs, and cross-origin clients can use
  this correct but slower path. Native Apple and Android clients, the TUI, and
  the SDK do not reconcile ancestor rows and retain their existing behavior.
  Clients apply the child and held full ancestor rows together, honoring each row's
  identity and clock. In full snapshots, omitted optional row facts
  clear previously held values, including child links, swarm summaries, and
  descendant-running flags. Non-null legacy top-level row fields do not fill
  omissions in a complete, viewer-filtered row. Explicit null clearing receipts
  and separate lifecycle receipts remain effective. The existing optional title/preview enrichment and
  thinking-metadata preservation rules still apply.
  The Control UI coalesces an authoritative
  refresh for missing rows or snapshots, broad/keyless changes, `catalogChanged`,
  membership filters, incomplete ancestor snapshots, and uncertain boundaries (including owner-first rows
  promoted into the shared page). Events overlapping a roster read retain a
  trailing refresh so its response cannot lose an update. A retained list with a
  read error also refreshes on the next relevant event. Profile identity, runner
  availability, and loaded cron bindings can produce broad invalidations.
  Activity-summary-only publications update opted-in Activity consumers; shared
  session and agent rosters do not refetch for those recap-only changes.
  Authorized incognito descriptions and events use the same row presentation from
  transient process-local state. Incognito rows remain excluded from the session
  roster, and queued events cannot cross a reset or database replacement.
  Tool/progress events keep delivering while rows refresh; their optional row
  metadata can be absent until ready. Full roster rows remain guaranteed on
  keyed `sessions.changed` and `session.message` snapshots.
  Active-run fields use the
  same aggregate and complete-exact semantics as `sessions.list`; `activeRunIds: null`
  clears cached exact identities to unavailable, omission leaves the cache unchanged,
  and an array replaces it. Delete notifications from `sessions.delete` and incognito
  reset carry the removed generation's `sessionId`, without a current-row snapshot.
  Clients must not delete a replacement with a different ID. A key-only delete event
  or a rowless global notification invalidates the canonical session list; it does
  not identify the current generation as deleted.
- `presence`: system presence snapshot updates.
- `tick`: periodic keepalive/liveness event.
- `health`: gateway health snapshot update.
- `heartbeat`: heartbeat event stream update.
- `cron`: cron run/job change event.
- `shutdown`: gateway shutdown notification.
- `node.pair.requested` / `node.pair.resolved`: node pairing lifecycle.
- `node.invoke.request`: node invoke request broadcast.
- `device.pair.requested` / `device.pair.resolved`: paired-device approval lifecycle.
- `device.pair.setup.completed`: exact setup-code handoff completion, scoped to
  `operator.pairing`.
- `device.pair.setup.deliveryUncertain`: replay-safe setup-code retirement whose
  credential response delivery could not be confirmed, scoped to `operator.pairing`.
- `voicewake.changed`: wake-word trigger config changed.
- `plugins.changed`: plugin runtime publication completed. The payload is
  `{ generation }`; refresh `plugins.list` to reconcile installed and runtime state.
- `config.changed`: a config write persisted (payload carries the config path,
  the new snapshot hash, and a timestamp — never config content). Operator-read
  scoped; clients refresh via `config.get`.
- `skills.changed`: connectivity, the skill catalog, config, or eligibility
  changed after the gateway invalidated its skills snapshot. The payload's
  `reason` is `watch`, `watch-targets`, `manual`, `remote-node`,
  `config-change`, or `workshop`. Operator-read scoped; clients refresh via
  `skills.status`.
- `exec.approval.requested` / `exec.approval.resolved`: exec approval
  lifecycle.
- `plugin.approval.requested` / `plugin.approval.resolved`: plugin approval
  lifecycle.

## Node helper methods

Nodes may call `skills.bins` to fetch the current list of skill executables
for auto-allow checks.

## Node exec lifecycle events

Nodes report `system.run` lifecycle through the node-role `node.event` RPC with
`event: "exec.started"`, `"exec.finished"`, or `"exec.denied"`. These are not the
operator `exec.approval.*` broadcasts and do not use the retired TCP bridge.

The RPC accepts a JSON string in `payloadJSON` or an object in `payload`. A string
`payloadJSON` takes precedence when both are supplied. For example:

```json
{
  "event": "exec.finished",
  "payload": {
    "sessionKey": "agent:main:main",
    "runId": "<exec-run-id>",
    "host": "node",
    "exitCode": 0,
    "timedOut": false,
    "success": true,
    "output": "done"
  }
}
```

Current headless nodes include `sessionKey`, `runId`, and `host: "node"`.
Additional fields are:

| Field                  | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `command`              | Raw or formatted command text.                               |
| `exitCode`, `timedOut` | Process completion code and timeout flag.                    |
| `success`              | Producer result flag, not the notification-gating predicate. |
| `output`               | Bounded combined stdout, stderr, and error text.             |
| `reason`               | Denial reason for `exec.denied`.                             |
| `suppressNotifyOnExit` | Suppress this invocation's system notification.              |

Echo the correlation fields forwarded with `system.run`; neither an ID nor the
payload's `host` field grants authority. The Gateway matches the authenticated
node and connection, run ID, and session key when the invocation binds one.
Unmatched events return `handled: false` with `reason: "unmatched_exec_event"` and
produce no system notification. A narrow legacy macOS-client path may match a
missing or mismatched run ID only to one unambiguous invocation on that
connection/session; new clients must send the issued run ID.

`exec.started` retains the authorization record; `exec.finished` and
`exec.denied` consume it before notification filtering. `tools.exec.notifyOnExit:
false` or `suppressNotifyOnExit: true` suppresses notifications. Denied events
never enqueue a system event or wake agent work. Finished events notify only for
timeout, nonzero or unknown exit code, or nonempty compacted output; successful
exit 0 with no output stays quiet. Finished notifications with a run ID are
deduplicated by canonical session and run ID. A heartbeat wake is requested only
after a system event is queued.

Node event delivery is best-effort, not a durable completion ledger.
