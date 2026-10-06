---
summary: "Tool-call isolation on a Crabbox-leased machine with fixed runtime identity and repository-owned execution"
title: "Crabbox backend"
read_when: "You want sandboxed tool execution on a throwaway cloud machine while the Gateway and agent loop stay local."
---

Run sandboxed tools on a machine leased by Crabbox. OpenClaw manages the remote workspace and filesystem bridge; Crabbox owns provider access, execution, and lease cleanup.

## Crabbox backend

Initial support is for direct Daytona leases. Install a Crabbox build with fixed-lease recovery, repository-owned `exec`, and `stop --current-repo`. Authenticate Crabbox for Daytona on the Gateway host, then check support from the workspace that will own the sandbox:

```bash
crabbox exec --check --provider daytona
```

This offline check must report both `execution: true` and `currentRepoStop: true`. OpenClaw performs the same capability check before provider allocation and reports an upgrade or unsupported-provider error when either capability is missing. Fixed lease IDs alone are insufficient; other providers become usable when Crabbox advertises both capabilities.

Use `backend: "crabbox"` to run `exec`, file tools, and media reads on a throwaway machine that [Crabbox](https://github.com/openclaw/crabbox) leases for the sandbox scope. The Gateway, the agent loop, channels, and model credentials stay on the host. This is the option for a personal Gateway that should keep its setup local but must not run model-generated commands on the host and cannot or should not run Docker. To move the whole session off the host instead, use [cloud workers](/gateway/cloud-workers).

The sandbox registry reserves one fixed Crabbox lease ID per scope before provisioning starts. Concurrent first use shares that reservation, and provisioning failures or Gateway restarts replay the same ID instead of allocating another machine. Shared scopes keep the original owning workspace even when a later caller uses a different local workspace. Native stopped or archived machines resume with their remote workspace intact. The shared remote-shell backend uploads the initial workspace and any separate agent workspace into a temporary sibling directory, then atomically publishes the complete tree. Interrupted uploads retry without adopting a partial tree, and an existing remote workspace remains canonical.

Every remote command, file operation, upload, and staged-exec cleanup runs through `crabbox exec --id <lease-id> -- ...` from the original workspace. Crabbox checks and retains its current repository claim for each execution; OpenClaw does not export or cache a lease's SSH credentials. A command prepared before a claim transfer must still pass Crabbox admission when launched. Remote PTY requests use `--pty`, while the local Crabbox process keeps piped input.

`openclaw sandbox recreate` releases the lease with `crabbox stop --current-repo --id <lease-id>`. Crabbox refuses to release a lease whose claim moved to another repository. After release succeeds, the next use reserves a new ID and provisions a fresh machine. Failed cleanup remains recorded for retry, and new provisioning waits until removal completes. If provisioning failed before Crabbox recorded a claim, recreate replays the reserved ID from its original workspace before releasing it. This can briefly provision and immediately release an unused machine; it avoids discarding an uncertain allocation.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "crabbox",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      crabbox: {
        enabled: true,
        config: {
          sandbox: {
            provider: "daytona",
            class: "small",
            ttl: "2h",
            idleTimeout: "30m",
          },
        },
      },
    },
  },
}
```

The `sandbox` block registers the backend. `provider`, `class`, `ttl`, and `idleTimeout` are optional and fall back to the Crabbox configuration on the host. Set `binary` to select a particular Crabbox executable; otherwise OpenClaw discovers a sibling build or uses `crabbox` from `PATH`. `agents.defaults.sandbox.ssh.workspaceRoot` still selects the remote root. Other SSH settings, including `target` and identity settings, do not configure the Crabbox transport: Crabbox owns its private provider connection.

Provider credentials are inherited by the local Crabbox process. They are not automatically copied into the remote command environment. OpenClaw stages the requested remote environment privately through the same command owner, preserving raw file bytes and command output.

`openclaw sandbox list`/`recreate`/prune treat Crabbox runtimes like other remote runtimes; removing a runtime releases the lease through repository-scoped cleanup. Every tool call crosses the network, so expect higher latency than Docker. Use the provider's idle and TTL settings and explicit cleanup to manage resource usage. Existing lease inspection, access, and cleanup follow Crabbox's stored provider claim. To switch providers, recreate the existing sandbox before starting work with the new provider. The sandboxed browser and `sandbox.docker.binds` are not supported on this backend.
