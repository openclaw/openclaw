# MCP Relay

Bundled, disabled-by-default connector for the OpenClaw MCP relay. The Gateway
opens an outbound WebSocket; no inbound Gateway port or configured Gateway token
or password is shared with the relay. Enable the plugin, follow any restart or
reload instruction printed by the command, then run `openclaw mcp-relay pair`.

[Setup and security model](https://docs.openclaw.ai/plugins/mcp-relay).

This version supports status, conversation listing, paginated conversation
reading, sending messages, and bounded reply polling. Messages use ordinary
operator input without a distinct `mcp-relay` transcript source label. A run
blocked on approval remains `running`; answer approval prompts in OpenClaw.

ChatGPT can also show the Gateway's full Control UI through the same outbound
connection, with no additional plugin configuration. This requires token or
password Gateway authentication without `gateway.roles`. The browser pairs as
an ordinary read/write device; admin and approval capabilities remain unavailable.
Revoke its token through the ordinary Devices controls on a direct OpenClaw
connection. Revoking its relay grant closes the UI path and its active work, but
does not revoke ordinary device tokens. The relay sees UI traffic, including
device tokens, in transit.

## Maintainer notes

All production imports stay within this plugin, Node built-ins, and documented
`openclaw/plugin-sdk/*` exports. The service scheduler owns connection lifetimes,
request deadlines, keepalive, and reconnects. CLI commands call the running
Gateway; they never create their own identity or relay connection.

| Operation                          | Supported SDK contract                                                                             | Source and documentation                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background lifecycle and clock     | `api.registerService({apiVersion:2,start,stop})`, `context.scheduler`                              | `src/plugin-sdk/plugin-entry.ts`; `docs/plugins/sdk-runtime/gateway-and-nodes.md`, Service scheduling                                                          |
| Private identity and grant state   | `api.runtime.state.openKeyedStore`, `withCurrent`, `observe`, `compareAndApply`                    | `src/plugin-sdk/plugin-state-runtime.ts`; `docs/plugins/sdk-runtime/state-and-system.md`, State namespaces                                                     |
| Identity precedent                 | Reef stores private keys in plugin-scoped SQLite; this plugin uses Ed25519 PKCS8 and `node:crypto` | `extensions/reef/src/state.ts`; no private Reef imports                                                                                                        |
| Outbound WebSocket                 | `WebSocket` from `plugin-sdk/websocket-runtime`                                                    | `src/plugin-sdk/websocket-runtime.ts`; `extensions/reef/src/transport.ts`                                                                                      |
| Remote Control UI transport        | Service-owned `context.controlUiIngress`, `GatewayIngressSocketV1`                                 | `openclaw/plugin-sdk/gateway-ingress`; `docs/plugins/sdk-gateway-ingress.md`                                                                                   |
| Running-Gateway CLI                | `api.registerCli`, `callGatewayFromCli`, `api.registerGatewayMethod`                               | `src/plugin-sdk/gateway-runtime.ts`; `docs/plugins/sdk-runtime/gateway-and-nodes.md`; Reef CLI itself uses relay HTTP, so it is not the RPC precedent          |
| Agent roster and default           | `listAgentIds`, `tryResolveDefaultAgentId`, canonical `config.agents.entries` names                | `src/plugin-sdk/agent-scope-runtime.ts`; `docs/plugins/sdk-migration/how-to-migrate.md`, roster helpers                                                        |
| Gateway version                    | `api.runtime.version`                                                                              | `docs/plugins/sdk-runtime.md`                                                                                                                                  |
| Conversation list                  | `api.runtime.gateway.withSessionFacts`                                                             | `docs/plugins/sdk-runtime/gateway-and-nodes.md`, immutable session facts; titles/previews are host-redacted                                                    |
| Session identity/existence         | `api.runtime.gateway.readSessionFacts`                                                             | Same reference; conversation existence for send/reply, incarnation rechecked for conversation reads                                                            |
| Paginated transcript               | `api.runtime.gateway.request("chat.history", ...)`                                                 | `docs/plugins/sdk-runtime/gateway-and-nodes.md`; `docs/gateway/protocol/rpc-session-control.md`; latest-tail anchor obtains the host-owned opaque older cursor |
| New or existing conversation input | `api.runtime.gateway.request("sessions.create", ...)` and `request("chat.send", ...)`              | `docs/plugins/sdk-runtime/gateway-and-nodes.md`; `docs/gateway/protocol/rpc-session-control.md`; ordinary operator input without a source-label override       |
| Bounded reply polling              | `api.runtime.gateway.request("agent.wait", ...)`                                                   | `docs/concepts/agent-loop.md`; `docs/plugins/sdk-runtime/background-work.md`; terminal run status and the owner's `terminalReply`                              |
| Run blocked on approval            | Remains `running`; no approval signal is inferred                                                  | `src/agents/run-wait.types.ts` has no run-correlated `waiting_for_approval` result                                                                             |
| Pending approvals count            | Omitted (optional in protocol)                                                                     | Approval endpoints require separate reviewer authority; none is acquired                                                                                       |

The read-only Session Share catalog (`extensions/session-share`) is another
public transcript precedent. This plugin uses worker-backed `chat.history`
instead of its legacy synchronous catalog reader. It does not use Admin HTTP
RPC's `dispatchGatewayMethod`: that capability requires an authenticated HTTP
request scope, which a relay socket does not supply.

### Control UI tunnel

The relay owns per-grant UI and sandbox HTTPS origins, browser sessions, and
routing. The plugin forwards paths unchanged through one lazily opened ingress
handle per active grant. Core owns HTTP routing, device pairing, tokens, scope
checks, and the isolation of the sandbox surface. The plugin uses the documented
`gateway-ingress` contract and requests only `operator.read` and `operator.write`.
The grant-state owner supplies the synchronous live-grant assertion; revocation,
service retirement, relay disconnect, and changed origins close owned work.
Sandbox-origin WebSocket opens return `forbidden` because the core contract has
no sandbox upgrade adapter.

Status reports UI availability from the optional host factory and the relay's
`ready.ui` announcement. It reports the normalized configured Control UI base
path, defaulting to `/`, without opening a handle. Authentication is checked on
the first real open. An `unsupported-auth` result becomes an `unavailable` error
with the core's configuration guidance and is cached until plugin restart or
configuration reload. The accepted first-launch edge is that an unsupported
Gateway displays this error inside the frame; subsequent status calls select
the conversations view.

Tunnel frames retain the 1 MiB frame ceiling, with at most 512 KiB of raw payload
per chunk. Per relay connection, the plugin limits work to 64 HTTP streams and
eight WebSockets, including pending opens, with 16 MiB request bodies and 32 MiB
of combined queued response data and partial WebSocket messages. HTTP heads have
a 60-second deadline and WebSocket opens a 10-second deadline. Core and endpoint
limits can be stricter. HTTP cancellation, socket closure, disconnect, and stop
settle the corresponding streams and sockets. Only core-issued
`pluginReadCookies` are forwarded as cookies; arbitrary `Set-Cookie` headers and
relay session cookies are excluded.

### State and update behavior

The existing plugin-state SQLite table holds one no-eviction authority record.
This makes pairing-code consumption and grant insertion one compare-and-apply
transaction without a new schema or cross-key transaction API. Identity is
created once with compare-and-apply, bound to its relay origin, and never
regenerated after corruption or an I/O failure. There are no JSON sidecars.

The authority record holds at most 100 live pairing codes and 1,000 grant IDs,
including permanent revocation tombstones, within a 512 KiB admission budget.
Admission reserves room for later timestamps, so reaching capacity cannot block
revocation. Expired codes are pruned when another code is issued; consumed live
codes remain unavailable. Capacity exhaustion refuses new pairing rather than
evicting authority. Pending operator revocations remain effective offline and
are replayed on reconnect. Failed/uncertain storage writes are not blindly retried.
Relay revocations for unknown IDs persist an ID/timestamp tombstone too, so an
in-flight grant creation cannot activate that ID afterward. These tombstones
appear in the CLI grant list without invented client metadata.

Updates preserve this plugin-owned state without migrations. Disablement closes
the service and its sockets; re-enablement keeps the same identity and grants.
Restore a compatible backup when recovering corrupted state. Changing the relay
origin is refused because existing authority belongs to the original relay.
No Doctor contract is needed for a new plugin with no legacy files or config.

### Current SDK limits

All five data operations use existing plugin contracts. The Gateway request
capability provides ordinary operator read/write authority; this plugin does
not acquire admin authority for relay requests. New sessions use
`sessions.create` without an idempotency key: the in-process client has no
authenticated principal or device identity, which idempotent session creation
requires. Existing-conversation input uses `chat.send` with its required fresh
idempotency key. Neither mutation is retried by this plugin.

Send/reply results use only `agent.wait` and its `terminalReply`. Visible replies
are truncated to the usual text limit; silent or empty terminal success completes
without reply text. A completed run whose snapshot is no longer available tells
the client to use `read_conversation`. There is no transcript reconstruction or
run-to-conversation admission cache: grants already cover all conversations.
Conversation existence and current grant/connection authority are still checked.
Waits are bounded by the requested `waitMs`, from zero to 50,000 milliseconds.
`conversation.read` continues to use paginated `chat.history`.

Gateway request failures and unexpected operation failures log one diagnostic
line through `api.logger`, including operation, Gateway method, and error
code/message. Request values are redacted; error details, stacks, and transcript
payloads are not logged.

The current SDK does not provide a source-labeled operator-input contract or
a run-correlated approval-state signal. This implementation therefore leaves
ordinary transcript attribution intact and returns only `completed`, `running`,
or `failed`. It never synthesizes `waiting_for_approval` from pending approvals
or elapsed time. The optional `pendingApprovals` status field is omitted.

Future source labeling should be bound to the registering plugin by the
existing agent-turn owner, rather than accepting caller-selected authority.
Approval status belongs with the existing run/approval owners. Those narrow
host contracts would require capability-ladder step 3; neither is implemented
by this plugin or required for its current send/reply operations. The Control UI
tunnel uses the separate core-owned remote ingress contract described above.
