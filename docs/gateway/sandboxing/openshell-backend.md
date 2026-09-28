---
summary: "The OpenShell managed sandbox, its mirror and remote workspace modes, and its lifecycle"
title: "OpenShell backend"
read_when: "You are sandboxing tools in an OpenShell-managed remote environment."
---

The OpenShell lifecycle built on the same SSH transport, and the difference between its mirror and remote workspace modes.

## OpenShell backend

Use `backend: "openshell"` to sandbox tools in an OpenShell-managed remote environment. OpenShell reuses the same SSH transport and remote filesystem bridge as the generic SSH backend, and adds OpenShell lifecycle (`sandbox create/get/delete/ssh-config`) plus an optional `mirror` workspace sync mode.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote", // mirror | remote
        },
      },
    },
  },
}
```

`mode: "mirror"` (default) keeps the local workspace canonical: OpenClaw syncs local into the sandbox before `exec` and syncs back after. `mode: "remote"` seeds the remote workspace once from local, then runs `exec`/`read`/`write`/`edit`/`apply_patch` directly against the remote workspace without syncing back; local edits after the seed are invisible until you `openclaw sandbox recreate`. Under `scope: "agent"` or `scope: "shared"`, that remote workspace is shared at the same scope. Current limitations: sandbox browser isn't supported yet, and `sandbox.docker.binds` doesn't apply to this backend.

`openclaw sandbox list`/`recreate`/prune all treat OpenShell runtimes the same as Docker runtimes; prune logic is backend-aware.

For the full prerequisites, configuration reference, workspace-mode comparison, and lifecycle details, see [OpenShell](/gateway/openshell).
