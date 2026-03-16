---
summary: "Concise summary of the slice-1 fixup for ACP node-runtime lease/run binding, suspect-lease gating, restart recovery, and proof corrections"
title: "ACP Node Foundation Slice 1 Fixup Summary"
---

# ACP Node Foundation Slice 1 Fixup Summary

## What was fixed

- runs are now bound to the `leaseId` and `leaseEpoch` that started them, so a replacement lease cannot continue or terminal an in-flight run from the old epoch
- `suspect` leases no longer count as valid for worker progress or terminal resolution; they must be explicitly reactivated by same-node reconcile before the run may continue
- restart loading now converts persisted non-terminal runs into `recovering` with `gateway_restart_reconcile`, and active leases into `suspect`, instead of reloading them as plain `running`
- the focused proof suite was corrected so it no longer blesses replacement-epoch handoff behavior for an existing run

## What tests prove it

Focused suites:

- `src/acp/store/store.test.ts`
- `src/acp/store/gateway-events.test.ts`
- `src/gateway/server-node-events.acp.test.ts`

Key proofs added or corrected:

- replacement lease epoch is rejected for a run started by the old epoch
- `suspect` lease terminal is rejected until explicit same-node reconcile succeeds
- reconcile reactivates the lease and permits normal terminal resolution again
- restart reload surfaces non-terminal state as `recovering` with `gateway_restart_reconcile`
- ingress-level ACP worker terminal rejection on `suspect` is proven through `handleNodeEvent`

## Remaining non-blocking gaps

- this is still slice 1 only; there is not yet a real node-host ACP worker or real `node.invoke` control-plane integration
- projector replay and delivery-checkpoint replay are still deferred beyond the store-level foundation
- operator-facing recovery/doctor surfaces are still deferred

## Review commit

- `58046656e` `ACP: fix slice-1 recovery and lease fencing`
