---
summary: "Sandboxed tool execution in a smol machine: a local microVM per scope with Docker-style workspace mounts and copy-on-write branching"
title: "smol backend"
read_when: "You want VM isolation for sandboxed tools on the Gateway host without a container runtime, or you want to branch a running sandbox."
---

Run sandboxed tools in a smol machine: a real Linux microVM on the Gateway host, booted from an OCI image, with the workspace mounted like the Docker backend mounts it. No container runtime is involved; the `smol` CLI drives the local engine.

## smol backend

Use `backend: "smol"` to execute `exec`, file tools, and media reads inside a microVM per sandbox scope. The Gateway, the agent loop, channels, and model credentials stay on the host. Each machine has its own kernel, so a sandbox escape has to cross a hardware virtualization boundary rather than a shared-kernel namespace boundary.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "smol",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      smol: {
        enabled: true,
        config: {
          image: "python:3.12-slim",
          cpus: 2,
          memoryMb: 2048,
        },
      },
    },
  },
}
```

### Prerequisites

Install the smol CLI and confirm the local engine works as the same operating system user that runs the Gateway:

```bash
smol --version
smol machine ls --local
```

The plugin shells out to that CLI for every lifecycle step. `plugins.entries.smol.config.command` points it at a different binary; the engine CLI (`smolvm`) is accepted too.

### Lifecycle

The first tool call for a scope creates a machine named `openclaw-smol-<hash of the scope key>`, labeled `openclaw.sandbox=1`, starts it, and waits until it accepts commands. A Gateway restart adopts the existing machine by name. `openclaw sandbox list`, `recreate`, and prune treat smol machines like Docker runtimes: `recreate` deletes the machine with `smol machine rm --force` and the next use creates a fresh one. A machine that an operator already deleted counts as removed.

Each `exec` stages the tool's environment into a short-lived script inside the guest and runs it through `smol machine exec`; file tools run the same shared remote-shell scripts the SSH and OpenShell backends use. Commands never pass through a host shell.

### Workspace mounts

Mounts follow the Docker backend: the sandbox workspace at `sandbox.docker.workdir` (or the plugin `workdir`), the agent workspace at `/agent` when it differs and `workspaceAccess` is not `none`, protected skill directories read-only, and any core-provided read-only resource mounts. `workspaceAccess: "ro"` mounts both workspaces read-only. Mounts are shared with the host directly; there is no copy or sync step, and edits land in the host workspace immediately.

`sandbox.docker.binds` is rejected for this backend. Container-only hardening knobs (`readOnlyRoot`, `tmpfs`, `capDrop`, seccomp and AppArmor profiles, `pidsLimit`, `ulimits`, `user`) do not apply; the VM boundary replaces them and the plugin config sets CPU and memory limits.

### Network

`sandbox.docker.network: "none"` (the default) gives the machine no egress. Any other value enables outbound network. Machines pull their image from inside the guest, so a no-egress machine boots once with network before any tool runs, stops, is switched to no network, and starts again; the sandbox only ever executes commands in the no-network boot. A Gateway restart re-checks the machine's network setting before adopting it. Per-host allow-lists are not supported yet because the engine cannot change egress policy after the pull.

Machines are always local. A `SMOL_CLOUD_TOKEN` in the Gateway's environment is withheld from sandbox commands, so a host workspace mount can never be scheduled onto cloud hardware.

### Branching

Machines start branchable by default (`plugins.entries.smol.config.branchable`). A running sandbox can be branched from the host with `smol machine branch --name openclaw-smol-<hash>`, producing copy-on-write clones that share RAM and disk with the original until they diverge. OpenClaw does not branch machines itself; this keeps the sandbox usable as a base for parallel experiments driven by other tooling. Set `branchable: false` to start plain machines.

### Limitations

- Sandbox browser is not supported.
- `sandbox.docker.binds` is rejected.
- Linux and macOS hosts only, matching the smol engine.

For CLI and engine details, see the [smol machines documentation](https://docs.smolmachines.com).
