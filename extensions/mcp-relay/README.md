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
connection. The tokenless browser and every MCP operation use the grant's owner
or person principal, capped by its selected operator scopes and the principal's
current authority. No ordinary paired-device token is created or sent through
the relay.

**Connected apps** is a native plugin-owned Control UI page. It lists your grants
(administrators see all), revokes your grants (administrators can revoke any),
issues pairing codes, and handles optional **Sign in with your Gateway** consent.
Read/write is the default; full role access can include administration and
approvals, and the consent view explains this risk. Team grants always belong to
the approving verified person; single-user grants use the owner. Profile IDs stay
on the Gateway and never go to the relay.

## Maintainer notes

All production imports stay within this plugin, Node built-ins, and documented
`openclaw/plugin-sdk/*` exports. The service scheduler owns connection lifetimes,
request deadlines, keepalive, and reconnects. CLI commands call the running
Gateway; they never create their own identity or relay connection.

| Operation                          | Supported SDK contract                                                                             | Source and documentation                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background lifecycle and clock     | `api.registerService({apiVersion:2,start,stop})`, `context.scheduler`                              | `src/plugin-sdk/plugin-entry.ts`; `docs/plugins/sdk-runtime/gateway-and-nodes.md`, Service scheduling                                                          |
| Private identity and grant state   | `api.runtime.state.openKeyedStoreV2`, opening `assertCurrent`, `observe`, `compareAndApply`        | `src/plugin-sdk/plugin-state-runtime.ts`; `docs/plugins/sdk-runtime/state-and-system.md`, State namespaces                                                     |
| Identity precedent                 | Reef stores private keys in plugin-scoped SQLite; this plugin uses Ed25519 PKCS8 and `node:crypto` | `extensions/reef/src/state.ts`; no private Reef imports                                                                                                        |
| Outbound WebSocket                 | `WebSocket` from `plugin-sdk/websocket-runtime`                                                    | `src/plugin-sdk/websocket-runtime.ts`; `extensions/reef/src/transport.ts`                                                                                      |
| Remote Control UI transport        | Service-owned `context.controlUiIngress`, `GatewayIngressSocketV1`                                 | `openclaw/plugin-sdk/gateway-ingress`; `docs/plugins/sdk-gateway-ingress.md`                                                                                   |
| Running-Gateway CLI                | `api.registerCli`, `callGatewayFromCli`, `api.registerGatewayMethod`                               | `src/plugin-sdk/gateway-runtime.ts`; `docs/plugins/sdk-runtime/gateway-and-nodes.md`; Reef CLI itself uses relay HTTP, so it is not the RPC precedent          |
| Agent roster and default           | Principal-bound `request("agents.list", ...)`, configured default agent                            | `src/plugin-sdk/agent-scope-runtime.ts`; `docs/plugins/sdk-migration/how-to-migrate.md`, roster helpers                                                        |
| Gateway version                    | `api.runtime.version`                                                                              | `docs/plugins/sdk-runtime.md`                                                                                                                                  |
| Conversation list                  | Principal-bound `request("sessions.list", ...)`                                                    | `docs/plugins/sdk-runtime/gateway-and-nodes.md`, principal-scoped session listing; titles/previews are host-redacted                                           |
| Session identity/existence         | Principal-bound `request("sessions.describe", ...)`                                                | Same reference; conversation existence for send/reply, incarnation rechecked for conversation reads                                                            |
| Paginated transcript               | Principal-bound `request("chat.history", ...)`                                                     | `docs/plugins/sdk-runtime/gateway-and-nodes.md`; `docs/gateway/protocol/rpc-session-control.md`; latest-tail anchor obtains the host-owned opaque older cursor |
| New or existing conversation input | Principal-bound `request("sessions.create", ...)` and `request("chat.send", ...)`                  | `docs/plugins/sdk-runtime/gateway-and-nodes.md`; `docs/gateway/protocol/rpc-session-control.md`; ordinary operator input without a source-label override       |
| Bounded reply polling              | Principal-bound `request("agent.wait", ...)`                                                       | `docs/concepts/agent-loop.md`; `docs/plugins/sdk-runtime/background-work.md`; terminal run status and the owner's `terminalReply`                              |
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
handle per active grant. Core owns HTTP routing, tokenless browser admission, scope checks, principal
authority, and sandbox isolation. The plugin uses the documented version-2
`gateway-ingress` factory with an explicit principal and scope ceiling. The same
`bindPrincipal()` capability supplies every grant's MCP requests and UI handles;
the plugin does not use the system-actor Gateway request path for grant work.
The grant-state owner supplies the synchronous live-grant assertion; revocation,
service retirement, relay disconnect, and changed origins close owned work.
Sandbox-origin WebSocket opens return `forbidden` because the core contract has
no sandbox upgrade adapter.

Status reports UI availability from the optional host factory and the relay's
`ready.ui` announcement. It reports the normalized configured Control UI base
path, defaulting to `/`, without opening a handle. Authentication is checked on
the first real open. An `unsupported-auth` result becomes an `unavailable` error
with the core's configuration guidance for that grant. A rejected owner grant
does not disable other person grants on the same Gateway. Core checks each
request against current authority and the grant's original ceiling. Rejected
opens are retried on the next request.

Tunnel frames retain the 1 MiB frame ceiling, with at most 512 KiB of raw payload
per chunk. Core ingress and the relay own concurrency, byte, and timeout limits.
HTTP cancellation, socket closure, disconnect, and stop
settle the corresponding streams and sockets. Only core-issued
`pluginReadCookies` are forwarded as cookies; arbitrary `Set-Cookie` headers and
relay session cookies are excluded.

### Sign-in and browser page

The plugin registers the `connected-apps` tab and serves its native browser
bundle through the existing immutable Control UI asset build. The plugin HTTP
route `/mcp-relay/connect?request=...` redirects to that tab under the Gateway's
normal authentication. The browser uses `host.request`; it never selects a
principal or forwards a profile ID to the relay. Gateway handlers derive the
caller, filter list/revoke access, and bound the requested ceiling.

Consent describes the pending relay request over the authenticated service
socket, then sends approval or denial back over that socket. Approval includes
the required principal kind, display label, and ceiling; only local state holds
the profile ID. The browser returns to the configured relay's `/oauth/continue`
URL after either decision. Query-string relay hints never select an outbound
relay or a browser redirect destination. Expired or foreign requests fail
without creating access.

The default is read/write. Full role access can include administration and
approvals; the UI describes this explicitly and only offers the caller's current
role ceiling. Sign-in remains optional alongside single-use pairing codes.
Person sign-in grants have a 30-day absolute relay refresh-token lifetime;
pairing-code and owner grant lifetimes remain unchanged.

### State and update behavior

The plugin-state SQLite keyed store holds the relay-bound identity, expiring
pairing codes, and active grants. Consuming a code deletes it; revoking a grant
deletes it. Unknown and revoked grants are refused identically, including while
the relay is offline. A crash between consuming a code and saving its grant
requires a new pairing code. There are no CAS retries, recovery records, or JSON
sidecars. Corrupt identities are refused rather than regenerated.

Disablement closes the service and its sockets; re-enablement keeps the same
identity and grants. No core schema changes are needed.
Restore a compatible backup when recovering corrupted state. Changing the relay
origin is refused because existing authority belongs to the original relay.
No Doctor contract is needed for a new plugin with no legacy files or config.

### Current SDK limits

All five data operations use the existing principal-bound ingress capability.
Read/write grants cannot acquire administration authority. Full grants are still
limited by the principal's live role, and verified-profile Gateways refuse owner
grants with guidance to reconnect as a person. New and existing conversation
input uses the host's session and chat owners; mutations are not retried by this
plugin.

Send/reply results use only `agent.wait` and its `terminalReply`. Visible replies
are truncated to the usual text limit; silent or empty terminal success completes
without reply text. A completed run whose snapshot is no longer available tells
the client to use `read_conversation`. There is no transcript reconstruction or
run-to-conversation admission cache; the principal-bound host owns visibility.
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
