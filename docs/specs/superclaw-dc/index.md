---
title: Superclaw DC Control Spine
description: Draft architecture specs, contracts, and experiments for Superclaw datacenter identity, isolation, policy, receipts, and memory lifecycle.
readWhen:
  - Designing Superclaw datacenter control-plane contracts
  - Reviewing tenant isolation, channel identity, capability, policy, receipt, or memory lifecycle boundaries
  - Running Superclaw DC contract experiments
---

# Superclaw DC Control Spine

This directory contains draft specs and runnable contract experiments for the Superclaw datacenter control spine.

Start with:

- `rfc-00-control-spine.md`
- `rfc-01-tenant-isolation.md`
- `rfc-02-gateway-l5-identity.md`
- `rfc-03-capability-pdp-receipt.md`
- `rfc-04-org-memory-outbox.md`

Runnable checks:

```bash
node docs/specs/superclaw-dc/experiments/contract-negative-tests.mjs
node docs/specs/superclaw-dc/experiments/schema-validation.mjs
```

Machine-readable contracts live under `contracts/v0/`.
