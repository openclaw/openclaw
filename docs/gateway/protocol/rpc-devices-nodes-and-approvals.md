---
summary: "Gateway RPC families for device pairing, node invoke, approvals, Control UI commands, and automation"
read_when:
  - Pairing a device or minting a device token
  - Invoking a node or draining its pending work
  - Resolving approvals or driving Control UI commands
title: "Gateway protocol device, node, and approval methods"
sidebarTitle: "Devices, nodes, and approvals"
doc-schema-version: 1
---

RPC method families for device pairing and device tokens, node pairing and invoke, approvals, Control UI commands, and automation, skills, and tools.

## Device pairing and device tokens

- `device.pair.list` returns pending and approved paired devices.
- `device.pair.setupCode` creates a mobile setup code and, by default, a PNG QR data URL. It requires `operator.admin` and is intentionally omitted from advertised discovery. Current gateways include an opaque non-secret `setupId`, authoritative `expiresAtMs`, `setupCode`, optional `qrDataUrl`, `gatewayUrl`, the non-secret `auth` label, `urlSource`, and the issued `access` level (`full`, `limited`, or `node`). Older protocol-v4 gateways omit `setupId` and `expiresAtMs`, so separately shipped clients must treat those lifecycle fields as optional. The `setupId` is independent from the bootstrap credential and is not embedded in the setup code.
- `device.pair.setupStatus` reconciles one setup credential the caller already issued (`{ setupId }`). It requires `operator.admin`, is omitted from advertised discovery, and returns either `{ completion }` after the credential-bearing response finishes or `{ deliveryUncertain }` when the bearer was retired but response delivery could not be confirmed. Both use the same non-secret payload as their corresponding events. When both fields are absent, the gateway holds no retained outcome for that `setupId`.
- `device.pair.approve`, `device.pair.reject`, and `device.pair.remove` manage device-pairing records.
- `device.pair.rename` assigns an operator label (`{ deviceId, label }`) that is preferred over the client-reported display name and survives device repair or re-approval.
- `device.token.rotate` rotates a paired device token within its approved role and caller scope bounds.
- `device.token.revoke` revokes a paired device token within its approved role and caller scope bounds.

The setup code embeds a short-lived bootstrap credential. Clients must not
log or persist it beyond the pairing flow.

Pairing-scoped clients receive `device.pair.setup.completed` only after the
exact setup handoff has delivered its credentials. Its payload is
`{ setupId, deviceId, deviceName?, access, ts }`; it never includes the
bootstrap credential or token-derived identifiers.

If the response closes before delivery can be confirmed, the gateway keeps
the bearer retired and emits `device.pair.setup.deliveryUncertain` instead
of success. The presenting client should offer the operator a path to inspect
or remove the paired device and generate a new setup code.

The gateway records an uncertain outcome when it consumes the bearer, then
promotes it to completion only after response delivery finishes. Operator
event frames are best effort and drop for slow subscribers rather than
closing their socket. A client that displayed a setup code must therefore
call `device.pair.setupStatus` before presenting the code as expired.
Outcomes are retained past the credential's own expiry.

## Node pairing, invoke, and pending work

- `node.pair.list`, `node.pair.approve`, `node.pair.reject`, and `node.pair.remove` cover node capability approvals. `node.pair.request` and `node.pair.verify` were removed in 2026.7 together with the standalone node pairing store; pending requests are created by the Gateway during node connects.
- `node.list` and `node.describe` return known/connected node state.
- `node.rename` updates a paired node label.
- `node.invoke` forwards a command to a connected node.
- `node.invoke.result` returns the result for an invoke request.
  A node may return `NODE_NOT_READY` only when lifecycle cleanup prevented
  execution, before calling a command handler or emitting progress. The
  Gateway retries this rejection up to four times within the original invoke
  deadline, rechecking the connection, pairing, and command authorization at
  each dispatch. General `UNAVAILABLE` errors, disconnects, timeouts, and
  failures after progress are not retried.
- `mcp.tools.call.v1` is the headless node-host command for calling a configured node-local MCP tool. It is carried through `node.invoke`, requires the node to declare the command, and remains subject to pairing approval and `gateway.nodes.commands.deny`.
- `node.event` carries node-originated events back into the gateway.
- `node.pluginTools.update` is the only publication path for replacing the connected node's agent-visible plugin/MCP tool descriptors; `connect` params do not carry them.
- `node.pending.pull` and `node.pending.ack` are the connected-node queue APIs.
- `node.pending.enqueue` and `node.pending.drain` manage durable pending work for offline/disconnected nodes.

## Approval families

- `approval.history` returns newest-first terminal approvals retained for 30 days for exec, plugin, and system-agent requests (scope `operator.approvals`). It supports cursor pagination plus an optional kind filter; pending approvals are not history rows. Treat each cursor as an opaque server token and return the exact value without padding, rewriting, or adding fields.
- `approval.get` and `approval.resolve` are the kind-agnostic durable approval methods (scope `operator.approvals`). `approval.get` returns a sanitized pending or retained terminal projection with a stable `urlPath`; `approval.resolve` accepts the canonical approval id, an explicit `kind`, and a decision, applies first-answer-wins resolution, and always returns the recorded canonical result.
- `exec.approval.request`, `exec.approval.get`, `exec.approval.list`, and `exec.approval.resolve` cover one-shot exec approval requests plus pending approval lookup/replay. They are protocol-boundary adapters over the same durable approval registry.
- `exec.approval.waitDecision` waits on one pending exec approval and returns the final decision (or `null` on timeout).
- `exec.approvals.get` and `exec.approvals.set` manage gateway exec approval policy snapshots.
- `exec.approvals.node.get` and `exec.approvals.node.set` manage node-local exec approval policy via node relay commands.
- `plugin.approval.request`, `plugin.approval.list`, `plugin.approval.waitDecision`, and `plugin.approval.resolve` cover plugin-defined approval flows.

## Control UI commands

- `ui.command` lets an `operator.write` caller send typed layout and navigation commands to connected Control UI clients that advertise the `ui-commands` capability.
- Commands cover pane split/close/focus, sidebar visibility, terminal/browser panel visibility and dock, and session navigation.
- Protocol v1 intentionally fans out to every connected capable Control UI. If none is connected, the request fails with `UNAVAILABLE` instead of pretending the layout changed.

## Automation, skills, and tools

- Automation: `wake` schedules an immediate or next-heartbeat wake text injection; `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` manage scheduled work.
- `cron.run` remains an enqueue-style RPC for manual runs. Clients that need completion semantics should read the returned `runId` and poll `cron.runs`.
- `cron.runs` accepts an optional non-empty `runId` filter so clients can follow one queued manual run without racing against other history entries for the same job.
- Skills and tools: `commands.list`, `skills.*`, `tools.catalog`, `tools.effective`, `tools.invoke`. See [Operator helper methods](/gateway/protocol/operator-methods#operator-helper-methods).
