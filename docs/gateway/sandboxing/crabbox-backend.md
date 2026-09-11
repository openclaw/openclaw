---
summary: "Tool-call isolation on a Crabbox-leased box: one fixed lease per sandbox scope driven through the SSH backend"
title: "Crabbox backend"
read_when: "You want sandboxed tool execution on a throwaway cloud machine while the Gateway and agent loop stay local."
---

Tool-call isolation on a machine that Crabbox leases for the sandbox scope, using the same SSH transport and remote filesystem bridge as the generic SSH backend.

## Crabbox backend

Daytona requires a Crabbox build containing [fixed-lease cleanup and expiry reconciliation](https://github.com/openclaw/crabbox/pull/2111). Crabbox v0.56.0 includes fixed Daytona lease IDs but predates that repair. Other providers still require their corresponding fixed-ID support.

Use `backend: "crabbox"` to run `exec`, file tools, and media reads on a throwaway machine that [Crabbox](https://github.com/openclaw/crabbox) leases for the sandbox scope. The Gateway, the agent loop, channels, and model credentials stay on the host. This is the option for a personal Gateway that should keep its setup local but must not run model-generated commands on the host and cannot or should not run Docker. To move the whole session off the host instead, use [cloud workers](/gateway/cloud-workers).

The sandbox registry reserves one fixed Crabbox lease ID per scope before provisioning starts. Concurrent first use shares that reservation, and provisioning failures or Gateway restarts replay the same ID instead of allocating another machine. Native stopped or archived machines resume with their remote workspace intact. It then hands the lease's SSH endpoint to the [SSH backend](/gateway/sandboxing/ssh-backend): the remote workspace is seeded once and becomes canonical. `openclaw sandbox recreate` stops the lease; after Crabbox confirms release, the next use reserves a new ID and provisions a fresh box. A failed cleanup remains recorded so recreate can retry it; new provisioning waits until removal completes. If provisioning failed before Crabbox recorded a claim, recreate replays the reserved ID from the original workspace before releasing it. This can briefly provision and immediately release an unused machine; it avoids discarding an uncertain allocation. Crabbox chooses the cloud provider. Only direct providers with fixed lease IDs are supported (for example Daytona, AWS, Machine0, and local containers), and Crabbox must be authenticated for that provider on the Gateway host.

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
            provider: "daytona", // any Crabbox provider with fixed lease IDs
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

The `sandbox` block is what registers the backend. `provider`, `class`, `ttl`, `idleTimeout`, and `binary` are optional and fall back to the Crabbox configuration on the host. `agents.defaults.sandbox.ssh.workspaceRoot` still selects the remote root. Lease endpoints and per-lease SSH keys come from `crabbox ssh`, so `agents.defaults.sandbox.ssh.target` and identity settings are ignored. Crabbox records each lease's host key in its per-lease `known_hosts` on first contact, and every later connection must match it; token-based providers such as Daytona put a short-lived token in the SSH user, which the backend obtains afresh through Crabbox when opening each SSH session. It does not cache a token based on the provider's default lifetime. One SSH backend handle retains the workspace bootstrap state across credential refreshes. SSH client connection diagnostics are suppressed because they can contain the token username; connection failures still report an exit status, and remote-command stderr is preserved.

`openclaw sandbox list`/`recreate`/prune treat Crabbox runtimes like other remote runtimes; removing a runtime stops the lease. Every tool call crosses the network, so expect higher latency than Docker, and the lease bills while it idles until `idleTimeout` or `ttl` releases it. Existing lease inspection, access, and cleanup follow Crabbox's stored provider claim. To switch providers, recreate the existing sandbox before starting work with the new provider. The sandboxed browser and `sandbox.docker.binds` are not supported on this backend.
