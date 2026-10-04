---
summary: "Protocol version constants, the N-1 node window, and client defaults"
read_when:
  - Debugging a protocol version mismatch
  - Setting minProtocol and maxProtocol in a client
  - Checking a client timeout, retry, or buffer default
  - Routing local administrative commands across CLI and Gateway versions
title: "Gateway protocol versioning"
sidebarTitle: "Versioning"
doc-schema-version: 1
---

Which protocol versions a client may negotiate, and the constants a reference client ships with.

## Versioning

- `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL_VERSION`,
  `MIN_NODE_PROTOCOL_VERSION`, and `MIN_PROBE_PROTOCOL_VERSION` live in
  `packages/gateway-protocol/src/version.ts`.
- Clients send `minProtocol` + `maxProtocol`. Operator and UI clients must
  include the current protocol in that range; current clients and servers run
  protocol v4.
- Authenticated clients with both `role: "node"` and `client.mode: "node"`
  may use the N-1 node protocol (v3). Lightweight restart probes use
  the same N-1 window. Device auth, pairing, scopes, command policy, and exec
  approvals are unchanged by this compatibility window. Plugin-owned node
  capabilities and commands are withheld until the node upgrades to the current
  protocol because their hosted surfaces are not part of the N-1 contract.
- Schemas and models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

### Client constants

The reference client implementation lives in `packages/gateway-client/src/`
(OpenClaw wraps it via the thin `src/gateway/client.ts` facade). These
defaults are stable across protocol v4 and are the expected baseline for
third-party clients.

| Constant                                  | Default                                               | Source                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`                        | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_CLIENT_PROTOCOL_VERSION`             | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_NODE_PROTOCOL_VERSION`               | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_PROBE_PROTOCOL_VERSION`              | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| Request timeout (per RPC)                 | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`requestTimeoutMs`)                                                              |
| Preauth / connect-challenge timeout       | `15_000` ms                                           | `packages/gateway-client/src/timeouts.ts` (`OPENCLAW_HANDSHAKE_TIMEOUT_MS` env can raise the paired server/client budget) |
| Initial reconnect backoff                 | `1_000` ms                                            | `packages/gateway-client/src/client.ts` (`GATEWAY_RECONNECT_POLICY`)                                                      |
| Max reconnect backoff                     | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`GATEWAY_RECONNECT_POLICY`)                                                      |
| Fast-retry clamp after device-token close | `250` ms                                              | `packages/gateway-client/src/client.ts`                                                                                   |
| Force-stop grace before `terminate()`     | `250` ms                                              | `FORCE_STOP_TERMINATE_GRACE_MS`                                                                                           |
| `stopAndWait()` default timeout           | `1_000` ms                                            | `STOP_AND_WAIT_TIMEOUT_MS`                                                                                                |
| Default tick interval (pre `hello-ok`)    | `30_000` ms                                           | `packages/gateway-client/src/client.ts`                                                                                   |
| Tick-timeout close                        | code `4000` when silence exceeds `tickIntervalMs * 2` | `packages/gateway-client/src/client.ts`                                                                                   |
| `MAX_PAYLOAD_BYTES`                       | `25 * 1024 * 1024` (25 MB)                            | `src/gateway/server-constants.ts`                                                                                         |
| Chat attachment ceiling                   | `agents.defaults.mediaMaxMb`, default 20 MB decoded   | `src/gateway/chat-attachment-policy.ts`                                                                                   |
| Chat attachment image ceiling             | `min(attachment ceiling, 6 MB)`                       | `src/gateway/chat-attachment-policy.ts`, `packages/media-core/src/constants.ts`                                           |

The server advertises the effective `policy.tickIntervalMs`,
`policy.maxPayload`, `policy.maxBufferedBytes`, and `policy.attachments` in
`hello-ok`; clients should honor those values rather than the pre-handshake
defaults or hardcoded attachment sizes.

The reference client lets finite requests own their configured deadline when
every pending request has one. An `expectFinal` request without a finite
`timeoutMs`, any request with `timeoutMs: null`, or a mix of finite and
unbounded requests keeps the tick watchdog active. If inbound events and
responses remain silent past the tick-timeout threshold, the client closes the
socket with code `4000`, rejects every pending request, and reconnects. It does
not replay rejected requests after reconnecting.

## Local state owner routing

Supported local administrative commands discover the process that owns their
selected physical state directory before opening mutation-capable state. A live
owner receives authenticated RPCs on its recorded local port; a configured remote
Gateway or URL override does not redirect these local targets. With no owner,
the CLI acquires exclusive lifecycle ownership and retains it until accepted work
and cleanup settle. An unreachable, uninspectable, or still-starting owner is not
evidence that the directory is offline.

These routes require `operator.admin` and `local-state-owner-routing-v1` in
`hello-ok.features.capabilities`. Method presence alone is insufficient. Except
for creation, which is covered by that original capability, each operation also
requires its own capability:

| Local operation                                              | RPC                        | Additional capability                |
| ------------------------------------------------------------ | -------------------------- | ------------------------------------ |
| `worktrees create`                                           | `worktrees.create`         | None                                 |
| `worktrees remove`, including lossless and exact-state modes | `worktrees.remove`         | `worktrees-remove-owner-v1`          |
| `worktrees restore`, including exact-state recovery          | `worktrees.restore`        | `worktrees-restore-owner-v1`         |
| `worktrees gc`                                               | `worktrees.gc`             | `worktrees-gc-owner-v1`              |
| `worktrees recover-removal`                                  | `worktrees.recoverRemoval` | `worktrees-recover-removal-owner-v1` |
| `worktrees retire-snapshot`                                  | `worktrees.retireSnapshot` | `worktrees-retire-snapshot-owner-v1` |
| `pairing list`                                               | `channels.pairing.list`    | `channels-pairing-list-owner-v1`     |
| `pairing approve`                                            | `channels.pairing.approve` | `channels-pairing-approve-owner-v1`  |
| Default `approvals get`                                      | `exec.approvals.get`       | `exec-approvals-get-owner-v1`        |
| Default `approvals set` and allowlist edits                  | `exec.approvals.set`       | `exec-approvals-set-owner-v1`        |

The CLI sends the discovered `expectedOwnerId`; the server checks the current
owner and requester before effects. Worktree creation also carries
`expectedRepoIdentity` as the captured repository directory's `device:inode`.
These fields identify the intended owner and target; they grant no permission.
See [worktree request and result contracts](/concepts/managed-worktrees#gateway-methods),
[channel pairing](/gateway/protocol/rpc-system-and-channels#channel-dm-pairing),
and [approval snapshots](/gateway/protocol/rpc-devices-nodes-and-approvals#approval-families).

### Refusals and uncertain outcomes

The CLI distinguishes `OWNER_UNAVAILABLE` (ownership cannot be established),
`OWNER_REFUSED` (dispatch did not occur or the server explicitly refused before
mutation), and `OUTCOME_UNKNOWN` (a dispatched operation may have taken effect).
A server error with `details.mutationAccepted: false` identifies the explicit
pre-mutation refusal; other errors after dispatch do not prove rollback.

None of these states triggers local fallback or automatic replay. For an older
Gateway, missing capability, or authentication refusal, update the Gateway or
fix authentication. To work offline, stop the Gateway through its service owner,
wait for ownership to release, and rerun the exact command. After an uncertain
reply, inspect the target and its operation-specific status or recovery output
before deciding whether to retry. The local route allows up to ten minutes for
the existing owner operation; a timeout does not transfer ownership.

### Mixed versions and retained boundaries

New clients require the complete capability for their operation even if an older
Gateway advertises the same method. They never drop a selector or guard to make
an old request fit. Existing RPC clients can omit the additive owner fields on
methods that predate routing and retain their existing response contracts. The
new `worktrees.recoverRemoval` and `worktrees.retireSnapshot` methods require
`expectedOwnerId`.

Older CLI and SDK binaries keep their existing direct-write behavior. Routing
does not intercept those writes, arbitrary trusted SQL, or another state root
sharing an external database. Match CLI, Gateway, and SDK versions; callers must
retain their existing foreign-commit freshness checks. Routing covers the named
operations above; it does not guarantee that the Gateway is the only SQLite writer.

The following boundaries retain their existing owners and contracts:

| Boundary                       | Retained behavior                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device bootstrap               | Implicit-loopback device-pairing recovery, QR/setup-code issuance, and SDK device tokens remain with the bootstrap owner so obtaining RPC credentials does not require those credentials first.                                                            |
| Configuration and agent setup  | Agent identity, bindings, and config editing retain file-authoring/reload behavior. Interactive agent creation and onboarding still stage auth, plugins, workspace, and config locally; their authoritative commit has not moved to this route.            |
| Exec-policy synchronization    | `exec-policy preset` and `exec-policy set` retain their existing local config/policy owner. Routing the `approvals` commands does not change these operations or execution authorization.                                                                  |
| Credentials                    | Model-auth keys/order and SDK auth writes, MCP OAuth, secret-store edits, and channel authentication retain their existing locking, invalidation, and lifecycle owners.                                                                                    |
| Client preferences             | The TUI's remembered session remains a client-preference write, not conversation authority.                                                                                                                                                                |
| Plugin and delivery state      | Plugin keyed stores and dedupe retain plugin ownership; delivery-queue operations retain outbound-owner admission.                                                                                                                                         |
| Session and workspace SDKs     | Session entry, maintenance, catalog/import/link, transcript/callback, and workspace/worktree APIs retain their existing contracts. Session cleanup, agent deletion, and foreign SDK workspace/worktree mutations are not covered by this routing contract. |
| Raw storage APIs               | Raw cron replacement and low-level SQLite SDK/native access are not made exclusive by CLI routing. Prefer domain RPCs where available; a worker in a different process is still a foreign writer.                                                          |
| Offline and maintenance owners | `sandbox recreate` requires exclusive offline ownership. Embedded execution, reset/uninstall, boot admission, migrations, Doctor, and update retain their existing lifecycle owners.                                                                       |

Updates do not require a new routing RPC to install the version that supplies it.
The installed updater and candidate Doctor retain their stop, drain, backup,
maintenance, and finalization contracts. This routing adds no protocol-version,
schema, configuration, retention, or durability change.
