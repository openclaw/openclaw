# A2A

Connect OpenClaw to other agents using the Agent2Agent protocol. The plugin
publishes an Agent Card, receives authenticated tasks, and sends messages to
configured peers using A2A 1.0 JSON-RPC.

## Get started

Enable `channels.a2a`, set your public `advertisedUrl`, and configure a separate
bearer token for each trusted peer under `channels.a2a.peers`. Add a peer's URL
and outbound token when OpenClaw should initiate messages to it.

Agent Card discovery is public. Limit `channels.a2a.exposeAgents` if only selected
agents should be advertised.

Peers can submit text tasks, not operator slash commands.

See the [A2A guide](https://docs.openclaw.ai/channels/a2a) for configuration,
authentication, and task polling.

## Protocol surface

The plugin implements the A2A 1.0 core operations over the JSON-RPC 2.0 binding
at `/a2a/v1`.

| Method                             | Notes                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `SendMessage`                      | Blocking by default; `returnImmediately` returns the task at once.              |
| `GetTask`                          | Returns the full task, including artifacts.                                     |
| `ListTasks`                        | Filtering by `contextId`/`status`, paging, `historyLength`, `includeArtifacts`. |
| `CancelTask`                       | Marks the task terminal and releases any blocking wait.                         |
| `SendStreamingMessage`             | SSE stream of the task lifecycle.                                               |
| `SubscribeToTask`                  | SSE stream attached to an existing, non-terminal task.                          |
| `CreateTaskPushNotificationConfig` | Register a webhook for task updates.                                            |
| `GetTaskPushNotificationConfig`    |                                                                                 |
| `ListTaskPushNotificationConfigs`  |                                                                                 |
| `DeleteTaskPushNotificationConfig` | Returns `null` (`google.protobuf.Empty`).                                       |
| `GetExtendedAgentCard`             | Authenticated card with operator-authored text.                                 |

Accepted 0.3-era aliases include `message/send`, `message/stream`, `tasks/get`,
`tasks/list`, `tasks/cancel`, `tasks/resubscribe`, `tasks/subscribe` and
`tasks/pushNotificationConfig/*`.

### Data model

Parts use the 1.0 `oneof` shape: `text`, `raw` (base64 inline file), `url`
(file reference) or `data` (structured JSON), each with optional `filename`,
`mediaType` and `metadata`. There is no `kind` discriminator. A `raw`/`url`
part whose `mediaType` falls outside `channels.a2a.inputModes` (default
`text/plain`; wildcards like `image/*` are allowed) is rejected with
`ContentTypeNotSupportedError` (`-32005`) before any prompt is built. Task
states cover the full 1.0 set, including the interrupted
`TASK_STATE_INPUT_REQUIRED` and `TASK_STATE_AUTH_REQUIRED` states, which a
follow-up message carrying the same `taskId` resumes. The agent reaches those
states behaviorally: prefixing its final reply with `[[input-required]] <question>`
(or `[[auth-required]] <note>`) pauses the task instead of completing it. The
directive is stripped and the remaining text becomes the status message the
peer must answer to resume.

Errors carry the specification's codes (`-32001` through `-32009`) plus a
`google.rpc.ErrorInfo` detail, so peers can branch on a stable `reason` instead
of parsing messages. JSON-RPC 2.0's own reserved codes carry no `reason` — the
numeric code is the contract there.

### Service parameters

- `A2A-Version` — requests declaring a version outside `1.0` are refused with
  `VersionNotSupportedError` (`-32009`).
- `A2A-Extensions` — a comma-separated opt-in. The response echoes only the
  extensions this agent actually declared and activated.

### Extensions

Declare extensions under `channels.a2a.extensions`. An entry marked
`required: true` is advertised as such in the Agent Card, and a request that does
not opt into it is refused with `ExtensionSupportRequiredError` (`-32008`) rather
than being served a degraded answer.

### Capabilities

`channels.a2a.capabilities` controls both what the Agent Card advertises and
which methods are served.

- `streaming` — on by default. When disabled, `SendStreamingMessage` and
  `SubscribeToTask` return `UnsupportedOperationError` (`-32004`).
- `pushNotifications` — **off by default**. Enabling it lets a peer register a
  webhook the Gateway will POST task updates to. Webhook URLs are chosen by the
  remote peer, so they are validated against `pushNotifications.allowedHostnames`
  and the shared SSRF guard; private-network targets stay blocked unless
  `pushNotifications.allowPrivateNetwork` is set.
- `extendedAgentCard` — off by default. While off, `GetExtendedAgentCard`
  returns `UnsupportedOperationError` (`-32004`); when on but no
  `extendedSkillDescriptions` are authored it returns
  `ExtendedAgentCardNotConfiguredError` (`-32007`).

Skill descriptions for the extended card come from
`channels.a2a.extendedSkillDescriptions`, keyed by agent id. Agent entries
themselves carry no description, so card text is configured here instead of
being inferred from the agent.

### REST binding

The HTTP+JSON/REST binding (`spec` §11) is available behind
`channels.a2a.rest.enabled`, served under `/a2a/v1/rest`. Paths mirror the
normative `google.api.http` annotations (`/message:send`, `/tasks/:id:cancel`,
`/tasks/:id/pushNotificationConfigs`, …).

Errors use the `google.rpc.Status` shape: `error.code` is the HTTP status,
`error.status` the canonical gRPC code name (needed because several A2A errors
share one HTTP status), and `error.details` carries the `ErrorInfo` reason for
A2A-specific failures.

### Discovery

The Agent Card is served at `/.well-known/agent-card.json` (the canonical
IANA-registered path), with `/.well-known/agent.json` retained as a 0.3-era
alias. The extended card is served at `/a2a/v1/extendedAgentCard` and requires
a configured peer bearer token.

Card responses carry `ETag` (hash of the rendered body), `Last-Modified` (the
account start instant) and `Cache-Control: public, max-age=300` — `private` on
the authenticated extended card — and answer a matching `If-None-Match` with
`304` (§8.6.1). A trailing slash on any served path (`/a2a/v1/`) is equivalent
to its bare form, because standard HTTP clients normalize base URLs that way.
