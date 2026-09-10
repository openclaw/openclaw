---
summary: "Sandboxing tools on an arbitrary SSH-accessible machine, and its remote-canonical workspace"
title: "SSH backend"
read_when: "You are offloading sandboxed tool execution to a remote machine over SSH."
---

The remote utility contract, authentication material, and the remote-canonical workspace this backend seeds once.

## SSH backend

Use `backend: "ssh"` to sandbox `exec`, file tools, and media reads on an arbitrary SSH-accessible machine.

The remote environment must provide `/bin/sh`, `python3`, and GNU-compatible
`stat` (`-c`) and `readlink` (`-f`) for the filesystem bridge. These utilities
must be available to the non-interactive SSH command, not just an interactive
login shell. The Gateway host does not need these remote utilities: a macOS or
Windows Gateway can use an SSH target that supplies them. This is a remote
utility contract, not a Linux-only Gateway requirement.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        scope: "session",
        workspaceAccess: "rw",
        ssh: {
          target: "user@gateway-host:22",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
          identityFile: "~/.ssh/id_ed25519",
          certificateFile: "~/.ssh/id_ed25519-cert.pub",
          knownHostsFile: "~/.ssh/known_hosts",
          // Or use SecretRefs / inline contents instead of local files:
          // identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          // certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          // knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

Defaults: `command: "ssh"`, `workspaceRoot: "/tmp/openclaw-sandboxes"`, `strictHostKeyChecking: true`, `updateHostKeys: true`.

- **Lifecycle**: OpenClaw creates a per-scope remote root under `sandbox.ssh.workspaceRoot`. On first use after create or recreate, it seeds that remote workspace from the local workspace once. After that, `exec`, `read`, `write`, `edit`, `apply_patch`, prompt media reads, and inbound media staging run directly against the remote workspace over SSH. OpenClaw does not sync remote changes back to the local workspace automatically.
- **Authentication material**: `identityFile`/`certificateFile`/`knownHostsFile` reference existing local files. `identityData`/`certificateData`/`knownHostsData` accept inline strings or SecretRefs, resolved through the normal secrets runtime snapshot, written to temp files with mode `0600`, and deleted when the SSH session ends. If both a `*File` and `*Data` variant are set for the same item, `*Data` wins for that session.
- **Remote-canonical consequences**: the remote SSH workspace becomes the real sandbox state after the initial seed. Host-local edits made outside OpenClaw after the seed step are not visible remotely until you recreate the sandbox. `openclaw sandbox recreate` deletes the per-scope remote root and seeds again from local on next use. Browser sandboxing is not supported on this backend, and `sandbox.docker.*` settings do not apply to it.
