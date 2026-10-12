# @openclaw/smol-sandbox

Official smol machines sandbox backend for OpenClaw.

This plugin runs each OpenClaw sandbox as a smol machine: a real Linux microVM
on the Gateway host, booted from an OCI image, with the agent workspace mounted
into the guest the same way the Docker backend mounts it into a container. It
needs no container runtime; the `smol` CLI drives the local engine.

Machines start branchable by default, so a running sandbox can be branched with
`smol machine branch` into copy-on-write clones that share RAM and disk with the
original until they diverge.

## Install

```bash
openclaw plugins install @openclaw/smol-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Install the smol CLI before enabling the backend. As the same operating system
user that runs the OpenClaw Gateway, verify:

```bash
smol --version
smol machine ls --local
```

Set `agents.defaults.sandbox.backend` to `"smol"`, enable
`plugins.entries.smol`, and restart the OpenClaw Gateway. Machine settings
belong under `plugins.entries.smol.config`:

| Key              | Default            | Meaning                                                                                                    |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `command`        | `smol`             | Path or name of the smol CLI. The engine CLI (`smolvm`) works too; its flags differ and the plugin adapts. |
| `image`          | `python:3.12-slim` | OCI image each machine boots. It needs `/bin/sh`, GNU coreutils, and `python3`.                            |
| `cpus`           | `2`                | vCPUs per machine.                                                                                         |
| `memoryMb`       | `2048`             | RAM ceiling per machine. The host commits only what the guest touches.                                     |
| `workdir`        | sandbox workdir    | Absolute guest path for the workspace mount. Overrides `sandbox.docker.workdir`.                           |
| `branchable`     | `true`             | Start machines as branch sources. Costs nothing until a branch is taken.                                   |
| `timeoutSeconds` | `120`              | Timeout for lifecycle commands. Image pulls on first create always get at least 5 minutes.                 |

`sandbox.docker.workdir`, `sandbox.docker.network`, `sandbox.docker.env`, and
`sandbox.workspaceAccess` apply to smol machines. `network: "none"` (the default)
means no egress: the machine boots once with network to pull its image, the
plugin waits until the guest answers a command (which proves the image is
provisioned), then stops it and restarts it with network disabled. No tool
command reaches the machine during that window, and a Gateway crash anywhere
in the sequence is repaired on the next call.

Mounts are fixed when a machine is created and are recorded on it as the
`openclaw.mountPlan` label. When the sandbox asks for different mounts, for
example after `workspaceAccess` goes from `rw` to `ro` or `none`, the plugin
stops and removes the old machine and creates a new one before running any
command, so a reduced policy can never execute against the old writable
mount. The workspace lives on the host, so only guest-local state (packages
installed inside the machine) is rebuilt. Machines created by a plugin version
that did not record the label are replaced once on first use.
Container-only hardening knobs (`readOnlyRoot`, `tmpfs`, `capDrop`, seccomp and
AppArmor profiles, `pidsLimit`, `ulimits`, `user`) do not apply; the VM boundary
replaces them. `sandbox.docker.binds` is rejected, because host bind targets are
not validated for this backend yet.

Machines run on the local engine only. A `SMOL_CLOUD_TOKEN` in the Gateway's
environment is withheld from sandbox commands so a workspace mount can never be
placed on cloud hardware.

## Package

- Plugin id: `smol`
- Package: `@openclaw/smol-sandbox`
- Minimum OpenClaw host: `2026.9.9`
- Docs: https://docs.openclaw.ai/gateway/sandboxing/smol-backend
