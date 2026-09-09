---
summary: "Pair a node to the Gateway, read its status, and upgrade a fleet in the right order"
read_when:
  - Pairing iOS/watchOS/Android nodes to a gateway
  - Reading node status, host stats, or approval scope
  - Upgrading a Gateway and its nodes across a protocol window
title: "Node pairing and status"
sidebarTitle: "Pairing and status"
---

## Pairing + status

Nodes use **device pairing**. A node presents a signed device identity during connect; the Gateway creates a device pairing request for `role: node`. Device approval admits the connection; the declared command surface needs a separate approval. The direct Apple Watch setup uses an admin-minted, short-lived node-only setup code to approve its fixed low-risk command surface; later capability expansion still requires normal approval.

For manual approval, run these commands on the Gateway:

```bash
openclaw devices list
openclaw devices approve <deviceRequestId>
```

Restart the installed node with `openclaw node restart`, or stop and rerun its
foreground `openclaw node run` command. For an app node paused for manual pairing,
restart node mode or the app. This reconnect creates a separate command-surface
request. Back on the Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <nodeRequestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

The two request IDs are distinct. Use `openclaw devices reject <deviceRequestId>`
to reject device admission instead of approving it. An initial unapproved surface
has no effective commands. During an expansion, previously approved commands
remain effective only while the node still declares them and Gateway policy
allows them.

SSH-verified and administrator-minted bootstrap enrollment can approve the first
surface automatically. Trusted-network device approval alone does not; inspect
`nodes pending` and approve the surface separately. Later command, capability,
or permission expansion still needs approval. Surface approval does not bypass
[Gateway command policy](/nodes/command-policy) or [local exec approvals](/tools/exec-approvals).

Pending device-pairing requests expire 5 minutes after the device's last retry — a device that keeps reconnecting keeps its one pending request (and `requestId`) alive instead of minting a new prompt every few minutes; see [Node pairing](/gateway/pairing) for the full request/approve lifecycle. If a node retries with changed auth details (role/scopes/public key), the prior pending request is superseded and a new `requestId` is created — clients get a `device.pair.resolved` event for the superseded request, and you should re-run `openclaw devices list` before approving.

Pending command-surface requests do not expire merely with time; they follow the
[capability approval lifecycle](/gateway/pairing#how-capability-approval-works).

- `nodes status` marks a node as **paired** when its device pairing role includes `node`.
- A connected native Mac can opt in to coalesced physical-input activity from
  **Settings -> Permissions -> Active computer detection**. Accessibility is
  also required. The Gateway marks the freshest eligible Mac as
  `active`, gives the agent a stable node-id hint, and routes node connection
  alerts there before a delayed fallback. See
  [Active computer presence](/nodes/presence) for setup, privacy, timing, and
  troubleshooting.
- The device pairing record is the durable approved-role contract. Token rotation stays inside that contract; it cannot upgrade a paired node into a role that pairing approval never granted.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject/remove/rename`) manages the node's approved command/capability surface on its canonical paired-device record. Device pairing owns both transport authentication and the durable node surface; there is no separate node pairing store.
- `openclaw nodes remove --node <id|name|ip>` revokes the device's `node` role in the paired-device store and disconnects that device's node-role sessions: a mixed-role device keeps its row and only loses the `node` role, while a node-only device row is deleted. `operator.pairing` may remove non-operator node rows on other devices; a device-token caller revoking its own node role on a mixed-role device additionally needs `operator.admin`.
- Approval scope follows the pending request's declared commands:
  - commandless request: `operator.pairing`
  - non-exec node commands: `operator.pairing` + `operator.write`
  - `system.run` / `system.run.prepare` / `system.which`: `operator.pairing` + `operator.admin`

Headless node hosts report the hardware model on macOS and Linux.

Connected CLI node hosts and the macOS app report CPU count, load averages,
memory, and home-volume disk capacity every 60 seconds, starting on connection.
The Gateway exposes the latest snapshot as `hostStats` in `node.list` and
`node.describe`. When received, it saves the snapshot on the paired node
record, so offline nodes keep showing last-known stats with the original
`updatedAtMs`. Connected nodes use live session stats. `openclaw nodes status`
and `openclaw nodes describe` show a compact stats summary with a last-known age
for offline nodes. Windows omits load averages, and unavailable disk capacity is
omitted. See
[Node host stats](/gateway/protocol/presence#node-host-stats) for the wire contract.

## Version skew and upgrade order

The Gateway WebSocket accepts authenticated node clients across an N-1 protocol window.
The current v4 Gateway therefore accepts v3 nodes when the connection declares
both `role: "node"` and `client.mode: "node"`. Operator and UI sessions must
still use the current protocol.

For staged fleet upgrades, upgrade the Gateway first, then upgrade each node.
An N-1 node remains visible and manageable while it is upgraded; the Gateway
logs `legacy node protocol accepted` with an upgrade recommendation. Pairing,
device authentication, command allowlists, and exec approvals still apply.
Plugin-owned capabilities and commands stay hidden until the node upgrades to
the current protocol. Nodes older than N-1 require an out-of-band upgrade before
reconnecting.

The direct watchOS HTTPS transport requires the current protocol version; update
the watch app with the Gateway before enabling direct mode.
