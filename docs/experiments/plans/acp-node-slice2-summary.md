# ACP Node Slice 2 Summary

Slice 2 moves the ACP node-backed runtime from an accepted gateway-store foundation onto the real live transport seams that matter next:

- live `node.event` RPC ingress now lands on the durable `AcpGatewayNodeRuntime` / `src/acp/store/store.ts` path
- the obsolete parallel ACP worker ingress and file-store path were removed
- node-host now advertises `acp:v1` plus the planned ACP control/status commands over existing `node.invoke`
- same-node reconnect can reconcile suspect leases through `acp.session.status` on live node connect, not only through heartbeat/direct helper recovery

## What this slice proves

- real `node.event` RPC traffic uses the durable lease-fencing and recovery state machine
- ACP worker validation failures on the live RPC path return structured `INVALID_REQUEST` errors instead of generic transport failures
- node-host answers `acp.session.ensure`, `acp.session.load`, `acp.turn.start`, `acp.turn.cancel`, `acp.session.close`, and `acp.session.status`
- gateway reconnect logic can reactivate a suspect lease from coherent `acp.session.status` and mark incoherent reconnect state `lost` with `status_mismatch`

## Focused verification

- `pnpm test -- src/node-host/invoke-acp.test.ts src/acp/store/store.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
- `pnpm tsgo`
- `pnpm build`
  - still fails with the pre-existing Bun/module-resolution error: `Cannot find module './cjs/index.cjs' from ''`

## Remaining work for later slices

- replace the node-host ACP command bookkeeping with the real runtime-backed worker implementation
- carry the durable gateway store forward into projector/checkpoint replay and broader ACP manager adoption
- decide whether lease expiry remains ingress-driven or needs a background sweeper once the full runtime path lands
