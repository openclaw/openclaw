---
doc-schema-version: 1
summary: "Map a repository to a default cloud worker profile and retain resource identity for cleanup"
title: "Per-project default profiles"
read_when: "You want a repository to pick its own cloud profile, or you are reconciling an interrupted provision."
---

Select a default profile from a managed worktree’s origin remote. Resource identity
and cleanup records remain durable when provisioning is interrupted.

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

In **Settings → Connections → Cloud environments**, select a repository and use **Machine → Change** to choose a configured profile. This writes its `cloudWorkers.projectProfiles` default. Repository identities are validated, and mappings to missing profiles are refused. Add defaults for repositories not yet listed, or remove a default, through configuration.

An explicit `profileId` or `deviceId` in `sessions.dispatch` always wins. A target-less project-profile lookup requires `operator.admin`. Deleting a profile from **Advanced → Machines** in Cloud environments also removes project defaults that reference it. If a manually configured mapping names a profile that is not present in `cloudWorkers.profiles`, dispatch stops with an error naming both the repository key and missing profile. A worktree with no `origin` or no matching mapping returns a typed `INVALID_REQUEST` without provisioning or falling back to another target.

The enrolled node stores its identity, durable device token, endpoint, worker bundles, and workspaces under an isolated per-lease state directory on the disposable box. Allocation retries use the fixed Crabbox lease and existing setup identity; first-device redemption requires its enrollment to remain live. Cleanup can retain that resource identity after cancellation without restarting the old dispatch.

OpenClaw derives one fixed `cbx_...` lease ID from the durable provision operation and passes it to `crabbox warmup --lease-id`; the generated slug is display metadata only. If warmup commits but its response is lost, Gateway reconciliation repeats the same fixed-ID operation and Crabbox returns or adopts only the exactly attested lease. Intent drift, terminal ID reuse, and ambiguous unverified resources are rejected without allocating a replacement.

Graceful Gateway shutdown cancels in-flight provisioning and releases its resources.
Startup does not reconstruct or replay that dispatch. The root session’s resume
input can request provisioning again after checking current state. Durable resource
identity, leases, and cleanup intent still prevent lost allocations from being
blindly replaced; explicit **Stop cloud worker…** keeps its destruction behavior.

An interrupted legacy dispatch may have allocated a random lease without recording its ID. OpenClaw cannot identify that allocation safely from the old operation alone. It refuses reconstruction and slug adoption, retaining the unresolved allocation and cleanup record across restarts instead of treating the resource as gone. Identify and clean up any prior lease before starting a new dispatch; do not guess by slug. Automatic identification or settlement of the old record is not supported. Legacy records already marked failed are not reopened automatically.
