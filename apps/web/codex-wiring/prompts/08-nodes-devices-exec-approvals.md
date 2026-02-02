# Ticket 08 — Nodes, Devices, Exec Approvals Wiring

## Goal
Wire power‑user infrastructure surfaces (nodes, device pairing, exec approvals) to gateway RPCs.

## Background
- Legacy UI already uses `node.list`, `device.pair.*`, `device.token.*`, `exec.approvals.*`.
- `apps/web` currently uses mock data for nodes/devices and tool approvals.

## Scope
- Nodes: connect to `node.list` and pairing RPCs as needed.
- Devices: connect to `device.pair.list/approve/reject` + `device.token.rotate/revoke`.
- Exec approvals: use `exec.approvals.get/set` + `exec.approvals.node.get/set` + `exec.approval.resolve`.

## Requirements
1. **Nodes view**
   - Render gateway nodes from `node.list`.
2. **Device pairing**
   - Show pending + paired devices via `device.pair.list`.
   - Approve/reject requests via `device.pair.approve/reject`.
3. **Device tokens**
   - Rotate/revoke tokens via `device.token.rotate/revoke`.
4. **Exec approvals**
   - Load/save approvals for gateway + node scopes.
   - Resolve approval requests from event queue.

## Fixed Decisions (Do Not Re‑decide)
- Exec approvals use:
  - Policy: `exec.approvals.get` / `exec.approvals.set` (global) and `exec.approvals.node.get` / `exec.approvals.node.set` (per‑node).
  - Requests: `exec.approval.request` / `exec.approval.resolve`.
  - Events: `exec.approval.requested` / `exec.approval.resolved`.
- `exec.approvals.set` and `exec.approvals.node.set` require `baseHash` from the latest `get`.

## Required Decisions (Blockers)
1. **Approvals queue source**
   - **Question:** should the UI rely solely on events for pending approvals, or also fetch a list via RPC?
   - **Allowed answers:** `events-only` or `events+polling`
   - **Required response format:** single literal from list.
2. **Node scope**
   - **Question:** when editing node approvals, how does UI select nodeId?
   - **Allowed answers:** `explicit-select` or `current-node-context`
   - **Required response format:** single literal from list.

## Files to Touch (expected)
- `apps/web/src/routes/nodes/index.tsx`
- `apps/web/src/hooks/queries/useNodes.ts` (create)
- `apps/web/src/hooks/mutations/useNodesMutations.ts` (create)
- `apps/web/src/hooks/queries/useDevices.ts` (create)
- `apps/web/src/hooks/mutations/useDevicesMutations.ts` (create)
- `apps/web/src/features/security/*` (if approvals live there)

## Acceptance Criteria
- Nodes/devices screens reflect live gateway data.
- Pairing actions work end‑to‑end.
- Exec approvals can be loaded, edited, and applied.

## Testing
- Manual: approve/reject a device request and verify list updates.
- Manual: change exec approvals and confirm saved.
