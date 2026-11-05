---
summary: "Connect frame, hello-ok payload, client capabilities, roles, and scopes"
read_when:
  - Writing the connect frame for a new client
  - Debugging a rejected or downgraded handshake
  - Choosing the role and scopes a client should request
title: "Gateway protocol handshake"
sidebarTitle: "Handshake and roles"
doc-schema-version: 1
---

Connect a client, read the Gateway response, and negotiate capabilities.
For authentication setup, see [Gateway authentication](/gateway/authentication);
for permissions, see [Operator scopes](/gateway/operator-scopes).

## Handshake

Gateway sends a pre-connect challenge:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Device-auth clients use the challenge `ts` as `connect.params.device.signedAt`.
For WebSocket challenges, `ts` must be a non-negative integer. Clients that
explicitly support Gateways from before `connect.challenge` existed may use local
time only when no challenge arrives; a received challenge with an absent or
malformed `ts` is invalid.

Client replies with `connect`:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Clients may send small requests immediately after `connect` when their parameters
do not depend on `hello-ok`. The Gateway queues up to 15 following frames, each at
most 64 KiB, until hello delivery completes. It then dispatches them in receipt
order under the connection's current authorization; responses may complete out of
order. Authentication rejection closes the connection and discards queued frames.
Clients must retire pending requests with that connection and wait for an accepted
hello before enabling authenticated UI actions.

This queue is existing protocol behavior. Using it changes neither the wire schema
nor protocol version 4; clients that wait for hello continue to work. Protocol
changes remain additive first, with an explicit version decision required for an
incompatible change.

### Hello response

The default connect deadline is 30 seconds, allowing authentication and profile
preparation to finish on busy or slower hosts. It is a total deadline, not an idle
timeout: progress does not extend it. The client connect watchdog and server
preauth timeout share this default. Operators can override the server budget with
`OPENCLAW_HANDSHAKE_TIMEOUT_MS`; configure connecting clients with the same budget.

When the Gateway already holds a named canonical owner and its local-owner
binding, initial connections and reconnects reuse those profile facts. Committed
profile writes update the retained catalog; creating an owner, adopting a missing
name, or restoring an absent binding still uses the profile writer. Merged or
misbound owners require `openclaw doctor --fix` before reconnecting. Every
connection retains its authentication, device authorization, role, and visibility
checks.

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 4,
    "server": { "version": "…", "connId": "…" },
    "features": { "methods": ["…"], "events": ["…"] },
    "snapshot": { "…": "…" },
    "auth": {
      "role": "operator",
      "scopes": ["operator.read", "operator.write"]
    },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 52428800,
      "tickIntervalMs": 15000,
      "attachments": { "maxBytes": 20971520, "maxImageBytes": 6291456 }
    }
  }
}
```

`server`, `features`, `snapshot`, `policy`, and `auth` are all required by
`HelloOkSchema` (`packages/gateway-protocol/src/schema/frames.ts`). `auth`
reports the negotiated role and the current socket's effective authorization
scopes even when no device token is issued (shape above). `deviceToken`, when
present, is the primary reusable credential for the same device and role.

Optional hello fields:

| Field                             | Client use                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.commit`, `server.builtAt` | Running Gateway build provenance, captured at startup and omitted when unavailable. Visible to authenticated members; the Control UI shows it in **Settings → About**, separately from frontend details. Diagnostic/update RPC scopes are unchanged.                                         |
| `controlUiUrl`                    | Credential-free public Control UI origin/base path for shareable links, independent of tunnels or dev servers. Omitted when `gateway.publicOrigin` is unset or the UI is disabled; grants no access.                                                                                         |
| `snapshot.appliedConfigHash`      | Active runtime's accepted config revision. Compare with `config.get.configRevisionHash` to detect unapplied saved changes. `config.get.hash` instead guards authored root/include-file writes.                                                                                               |
| `snapshot.controlUiIdentityUrl`   | HTTPS dashboard sign-in URL for trusted-proxy/Tailscale Serve identity. Use normal HTTPS trust, not native TLS pins; never send native connection tokens/passwords. Refresh on reconnect and discard on disconnect. Serve-route removal/replacement closes affected connections with `1012`. |
| `pluginSurfaceUrls`               | Map of surface names to scoped, potentially expiring URLs. Renew with `{ surface: "canvas" }` through `node.pluginSurface.refresh` (nodes) or `plugin.surface.refresh` (Control UI with `operator.read`, including write/admin). Stop automatic renewal on `FORBIDDEN` until reconnect.      |

Clients with `operator.admin` also receive the running Gateway's `authMode`,
`bindHost`, and `tailscaleMode`. These include startup flags such as `--bind`
and `--tailscale`, which the config file can't show. Older Gateways omit
`bindHost` and `tailscaleMode`, so clients must not infer exposure from their
absence.

### Attachment limits

`policy.attachments` is optional (older gateways omit it) and advertises
the decoded-size ceilings chat attachments face on `chat.send`, `sessions.send`,
and session-creation initial turns:

| Field           | Meaning                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `maxBytes`      | Largest decoded size accepted for a single attachment (`agents.defaults.mediaMaxMb`, default 20 MB) |
| `maxImageBytes` | Largest decoded size accepted for a single image: `min(maxBytes, 6 MB agent-hydration cap)`         |

Validating before send:

1. Check each file's decoded size against `maxImageBytes` for images and
   `maxBytes` for everything else.
2. Serialize the whole request and check its encoded size against
   `policy.maxPayload`. `policy.attachments` is a per-attachment ceiling, never a
   promise the frame fits: attachments travel as base64, so a 20 MB file is about
   26.7 MB on the wire and exceeds the default 25 MiB frame limit on its own.
3. Treat the server as authoritative for everything else. Accepted MIME types and
   per-message handling are deliberately not advertised because they depend on
   the entrypoint, the resolved model, and payload sniffing. The gateway can
   return a typed rejection, while text-only model runs can omit additional
   images after their offload cap and still complete the request.
4. Re-read the values on every reconnect. They are a connection-time snapshot, so
   a live `mediaMaxMb` edit reaches existing connections only after they reconnect.

### Connection lifecycle and credentials

`openclaw.setup.verify` checks active config/restart state before and after live
inference. It returns `{ ok: false, status: "unavailable", error }` while saved
settings are unapplied, restart work remains, or the verified runtime changes.
Preserve the selected model and retry after application/restart. Standalone CLI
verification tests saved configuration without requiring a running Gateway.

Retired APIs: use plugin surfaces instead of `canvasHostUrl`, `canvasCapability`,
or `node.canvas.capability.refresh`; use `sessions.companion.ask` instead of
`sessions.observer.ask`.

While the Gateway is preparing authentication and request state, `connect` can return a
retryable `UNAVAILABLE` error with `details.reason: "startup-sidecars"` and
`retryAfterMs`. Retry within your connection budget instead of treating it as
a terminal handshake failure. Once that state is ready, authenticated clients can
connect and read available sessions while background recovery continues. Writes
retain their startup and per-agent recovery gates; node enrollment retains its
startup-specific admission checks.

When a device token is issued, `hello-ok.auth` adds it:

```json validate=false
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read"]
  }
}
```

Built-in QR/setup-code bootstrap is a mobile handoff path. A successful
baseline setup-code connect returns a primary node token plus one bounded
operator token:

```json validate=false
{
  "auth": {
    "deviceToken": "…",
    "role": "node",
    "scopes": [],
    "deviceTokens": [
      {
        "deviceToken": "…",
        "role": "operator",
        "scopes": ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"]
      }
    ]
  }
}
```

This operator handoff is bounded on purpose: enough to start the mobile
operator loop and native setup, with `operator.write` satisfying Talk sessions
and `operator.talk.secrets` covering Talk config reads, but no pairing-mutation scopes
and no `operator.admin`. Broader
pairing/admin access needs a separate approved pairing or token flow. Persist
`hello-ok.auth.deviceTokens` only when bootstrap auth ran over a trusted
transport (`wss://` or loopback/local pairing).

Trusted local backend clients (`client.id: "gateway-client"`,
`client.mode: "backend"`) may omit `device` on direct loopback connections when
authenticating with the shared gateway token/password. This path is reserved
for internal control-plane RPCs (e.g. subagent session updates) and avoids
stale CLI/device pairing baselines blocking local backend work. The exception
also applies when that backend supplies a signed device identity: it does not
create a pairing record, so an unpaired identity receives no device token.
Remote, browser-origin, node, and non-backend clients follow their normal pairing
and scope-upgrade policies. Device-token authentication still validates the
existing token's role and scopes before any local-backend pairing exception.

### Worker role and closed protocol

A Gateway-owned launcher starts the worker process through
[`openclaw worker`](/cli/worker); it is not a manual registration command.
Workers use a closed protocol through either the public
`/__openclaw__/worker` WebSocket path on the main TLS endpoint or the dedicated
loopback ingress reached through the gateway-owned, host-key-pinned SSH tunnel.
The route selects worker mode before reading frames, so it never dispatches
general auth, node events, operator RPCs, or plugin methods. Public admission
shares the main per-client pre-auth budget and authentication rate limiter; its
wire errors collapse credential and environment details to
`admission-rejected`, while trusted gateway diagnostics retain the internal
reason. A strict `connect` verifies a hash-at-rest, short-lived credential bound
to the environment, bundle hash, owner epoch, RPC-set version, expiry, and one
nullable session; it separately checks the current version and feature set.
Success returns minimal `worker-hello-ok`; feature negotiation is independent of
the general protocol version. Frames stay under 64 KiB, except a negotiated
`worker.inference.start` frame may be up to 25 MiB. The closed allowlist contains
`worker.heartbeat`, `worker.transcript.commit`, `worker.live-event`,
`worker.inference.start`, and `worker.inference.cancel`.

Assistant messages in `worker.transcript.commit` may carry the live event's
`itemId`. The Gateway binds it to its generated commit key, removes it before
storage, and publishes the correlation only after the row commits. It is not
provider replay data. This worker-only field travels between the exact
builds admitted by the bundle, version, and feature checks above.

For an identity-audited attached run, the live turn capability can record the
credential, build, owner-epoch, and placement checks as one enforced admission
receipt. The receipt contains none of the credential, build hashes, tokens,
environment id, or session id. Worker operation rows and placement state remain
their authoritative owners; successful connection is not an action-success
receipt.

Transcript commits use owner-epoch fencing, a gateway-owned session binding,
base-leaf compare-and-swap, and durable sequence replay; the gateway generates
transcript entry and parent IDs through the normal session writer. Ownership and
expiry are rechecked on each RPC.

<a id="chat-input-custody-capability" />

### Server capabilities

`hello-ok.features.capabilities` advertises supported contracts, not permissions.
If a marker is absent, support is unknown: retain existing behavior rather than
infer support from the protocol version or method list. Examples:

- `chat-input-custody-v1`: chat queue modes and exact input receipts; see
  [Chat input reconciliation](/gateway/protocol/rpc-session-control#chat-input-reconciliation).
- `chat-send-routing-contract`: chat send routing; see
  [Session control](/gateway/protocol/rpc-session-control).
- `control-ui-browser-focus`: bundled Control UI focus routing; omitted for
  configured UI roots or a disabled Control UI.

### Client capabilities

Declare optional capabilities in `connect.params.caps`. Older Gateways ignore
unsupported capability declarations.

| Capability                     | Effect                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-publication-unchanged` | Includes `unchanged: true` when a publication receipt confirms reuse of an existing PR without a push.                                                                          |
| `hello-health-on-demand`       | Sends `snapshot.health: {}` instead of cached health; required snapshot fields, version counters, health RPCs, and events remain.                                               |
| `health-summary`               | Omits `agents` and `sessions` from health events and cached hello health. Other health fields remain; the `health` RPC retains full diagnostics.                                |
| `hello-presence-self`          | Sends only the connecting client's hello presence row. The presence event stream supplies the full roster, including the initial reset for `presence-deltas` clients.           |
| `tool-events`                  | Accepts structured tool lifecycle events.                                                                                                                                       |
| `inline-widgets`               | Renders hosted inline widget tool results.                                                                                                                                      |
| `no-question-input`            | Cannot collect structured answers; turns omit `ask_user` and ask in ordinary text (used by the ACP bridge).                                                                     |
| `ultrafast`                    | Accepts the explicit `"ultrafast"` value. Without it, session responses/events project it as Fast (`true`) for released decoders; stored selection and execution are unchanged. |
| `chat-only-assistant-text`     | Renders assistant text from `chat`, omitting redundant assistant-text `agent` events. See [event families](/gateway/protocol/rpc-bootstrap-and-events#common-event-families).   |
| `chat-queue-status`            | Displays authoritative pending-input receipts instead of transient successful queue acknowledgments. Refusals, drops, and errors remain visible.                                |

Without the health/presence options, clients retain full cached hello health and
presence. The Control UI advertises `hello-health-on-demand` and
`hello-presence-self`; the presence stream avoids caching a roster across
connections. Keep the `ultrafast` legacy projection while released decoders need it.

Capabilities do not grant authorization. For tools that require client capabilities:

- The session records the operator declaration on each operator turn. Empty
  declarations or channel turns clear it; internal wakes and restart resumes
  retain it. Existing sessions acquire it on their next operator turn; reset or
  deletion removes it.
- Tool listing uses that session fact. Execution still checks current client
  capabilities and, for attached-client tools, the bound recipient's connection.
  For example, `screen` requires its requesting Control UI to remain connected.

### Node connect example

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Roles and scopes

For the full operator scope model, approval-time checks, and shared-secret
semantics, see [Operator scopes](/gateway/operator-scopes).

Roles:

- `operator`: control-plane client (CLI/UI/automation).
- `node`: capability host (camera/screen/canvas/system.run).
- `worker`: cloud execution host on the dedicated, closed worker protocol.

Request the least privilege needed; `hello-ok.auth.scopes` reports the effective
grants. Use the canonical [scope table](/gateway/operator-scopes#scope-levels)
and [method-level checks](/gateway/operator-scopes#method-scope-is-only-the-first-gate).
In particular:

- `operator.write` also satisfies `operator.talk`; Talk secret reads require
  `operator.talk.secrets` or admin. Use `talk.resolved.config.apiKey` for the
  resolved secret, not source-shaped `talk.providers.<id>.apiKey`.
- Reserved plugin RPC prefixes (`config.*`, `exec.approvals.*`, `wizard.*`,
  `update.*`) require admin. Persistent `/config set` and `/config unset` also
  require admin even when reached through lower-scoped `chat.send`.
- [Pairing](/gateway/operator-scopes#node-pairing-approvals)
  require additional scopes based on the declared commands.
- Gateway `fs.listDir` needs write for workspace-contained host browsing and admin
  when `nodeId` is present. Pass returned paths verbatim, including whitespace.

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories such as `camera`, `canvas`, `screen`,
  `location`, `voice`, and `talk`.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.
Connected nodes can publish optional agent-visible plugin or MCP tool
descriptors with `node.pluginTools.update` after a successful connect or
reconnect. Headless node hosts restart to apply declarative MCP inventory
changes. This update method is the only publication path; plugin tool descriptors are not accepted in
`connect` params. Each descriptor must use a provider-safe tool `name` and name
a `command` in the node's current command allowlist. The Gateway trusts descriptor
metadata from the paired node, filters descriptors outside the approved command
surface, removes them when the node disconnects, and rejects operator attempts
to mutate another node's catalog. Set `gateway.nodes.pluginTools.enabled: false`
to ignore node-published descriptors.

Connected node hosts publish their complete skill replacement catalog with
`node.skills.update`. This node-role method is the only node skill publication
path; skills are not accepted in `connect` params. Each descriptor contains a
safe name, description, and bounded `SKILL.md` content. The Gateway parses that
content with the normal skills loader, includes it in agent skill snapshots
while the node is connected, and removes it on disconnect. Set
`gateway.nodes.allowSkills: false` to ignore node-published skills.
