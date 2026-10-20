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

The plugin shells out to that CLI for every lifecycle step. `plugins.entries.smol.config.command` points it at a different binary; the engine CLI (`smolvm`) works too (the plugin uses its flags). smol or smolvm 1.23.0 or newer is required, because no-egress machines rely on the engine fetching images on the host. With `smol` 1.29.1 and older, `openclaw sandbox list` reports the image of a no-egress machine as changed, because those releases print the host-fetched copy instead of the configured image; `smolvm` and newer `smol` releases report it correctly. Isolation is not affected.

### Lifecycle

The first tool call for a scope creates a machine named `openclaw-smol-<hash of the scope key>`, labeled `openclaw.sandbox=1`, starts it, and waits until it accepts commands. A Gateway restart adopts the existing machine by name. `openclaw sandbox list`, `recreate`, and prune treat smol machines like Docker runtimes: `recreate` deletes the machine (`smol machine rm --name <machine> --yes --local`, or `smolvm machine rm --name <machine> --force` with the engine CLI) and the next use creates a fresh one. A machine that an operator already deleted counts as removed.

Each `exec` stages the tool's environment into a short-lived script inside the guest and runs it through `smol machine exec`; file tools run the same shared remote-shell scripts the SSH and OpenShell backends use. Commands never pass through a host shell.

### Workspace mounts

Mounts follow the Docker backend: the sandbox workspace at `sandbox.docker.workdir` (or the plugin `workdir`), the agent workspace at `/agent` when it differs and `workspaceAccess` is not `none`, protected skill directories read-only, and any core-provided read-only resource mounts. `workspaceAccess: "ro"` mounts both workspaces read-only. Mounts are shared with the host directly; there is no copy or sync step, and edits land in the host workspace immediately.

`sandbox.docker.binds` is rejected for this backend. Container-only hardening knobs (`readOnlyRoot`, `tmpfs`, `capDrop`, seccomp and AppArmor profiles, `pidsLimit`, `ulimits`, `user`) do not apply; the VM boundary replaces them and the plugin config sets CPU and memory limits.

### Network

`sandbox.docker.network: "none"` (the default) gives the machine no egress. Any other value enables outbound network. A no-egress machine is created without network and never has it: the engine fetches the image on the host at first start, so no guest code, including the image's own startup commands, ever runs with network it was not granted. The machine records the policy it was created for as the `openclaw.network` label, beside the `openclaw.mountPlan` label for its mounts. When either no longer matches the sandbox config (for example `workspaceAccess` reduced from `rw` to `ro`, or `network` changed to `"none"` after tools ran with egress), the machine is removed and recreated before any command runs, so a guest that ran with egress is never booted with network again. A no-egress machine whose network was turned on outside OpenClaw is replaced the same way. A Gateway restart re-checks both labels and the machine's network setting before adopting it. Per-host allow-lists are not supported yet.

Machines are always local. A `SMOL_CLOUD_TOKEN` in the Gateway's environment is withheld from sandbox commands, so a host workspace mount can never be scheduled onto cloud hardware.

### Branching

Machines start branchable by default (`plugins.entries.smol.config.branchable`). A running sandbox can be branched from the host with `smol machine branch --from openclaw-smol-<hash> --name experiment-1 --local`, producing copy-on-write clones that share RAM and disk with the original until they diverge. OpenClaw does not branch machines itself; this keeps the sandbox usable as a base for parallel experiments driven by other tooling. Set `branchable: false` to start plain machines.

### Limitations

- Sandbox browser is not supported.
- `sandbox.docker.binds` is rejected.
- Linux and macOS hosts only, matching the smol engine.

For CLI and engine details, see the [smol machines documentation](https://docs.smolmachines.com).
