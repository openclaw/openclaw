---
summary: "Map a repository to a default cloud worker profile, and how provision replay adopts a fixed lease"
title: "Per-project default profiles"
read_when: "You want a repository to pick its own cloud profile, or you are reconciling an interrupted provision."
---

Selecting a default profile from a managed worktree's origin remote, and how the enrolled node's state and fixed lease ID survive an interrupted dispatch.

## Per-project default profiles

Use `cloudWorkers.projectProfiles` to select a default profile from a managed session worktree's `origin` remote. Keys use the normalized lowercase repository identity `host/owner/repo`, without a trailing `.git`:

```json5 validate=false
{
  cloudWorkers: {
    projectProfiles: {
      "github.com/acme/app": "aws",
    },
  },
}
```

An explicit `profileId` or `deviceId` in `sessions.dispatch` always wins. A target-less project-profile lookup requires `operator.admin`. Deleting a profile from the Cloud workers settings also removes project defaults that reference it. If a manually configured mapping names a profile that is not present in `cloudWorkers.profiles`, dispatch fails closed and names both the repository key and missing profile. A worktree with no `origin` or no matching mapping returns a typed `INVALID_REQUEST` without provisioning or falling back to another target.

The enrolled node stores its identity, durable device token, endpoint, worker bundles, and workspaces under an isolated per-lease state directory on the disposable box. Provision replay first adopts the fixed Crabbox lease, then either resumes that node state or reuses the still-pending setup credential. It never mints a second environment identity for the same operation.

OpenClaw derives one canonical `cbx_...` lease ID from the durable provision operation and passes it to `crabbox warmup --lease-id`; the deterministic slug is display metadata only. If warmup commits but its response is lost, Gateway reconciliation repeats the same fixed-ID operation and Crabbox returns or adopts only the exactly attested lease. Intent drift, terminal ID reuse, and ambiguous unverified resources fail closed without allocating a replacement.

A Gateway restart that interrupts pending provisioning leaves the placement in `provisioning` and resumes the same environment and provider operation after startup. Explicit **Stop cloud worker…** still requests destruction and prevents replay.

An interrupted legacy dispatch may have allocated a random lease without recording its ID. OpenClaw cannot identify that allocation safely from the old operation alone. It refuses replay and slug adoption, retaining the unresolved allocation and cleanup record across restarts instead of treating the resource as gone. Identify and clean up any prior lease before starting a new dispatch; do not guess by slug. Automatic identification or settlement of the old record is not supported. Legacy records already marked failed are not reopened automatically.
