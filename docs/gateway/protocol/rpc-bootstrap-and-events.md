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
  Critical notice history starts fresh when the identity pair changes, including
  when `/clear` preserves `sessionId` and changes `lifecycleRevision`.
  Clients show its headline or inspector link only while the digest's exact `runId`
  is present in `activeRunIds`.
- `sessions.changed`: session index or metadata changed. Active-run fields use the
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
