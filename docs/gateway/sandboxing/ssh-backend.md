---
summary: "Sandboxing tools on an arbitrary SSH-accessible machine, and its remote workspace as the source of truth"
title: "SSH backend"
read_when: "You are offloading sandboxed tool execution to a remote machine over SSH."
---

The remote utility contract, authentication material, and the remote workspace this backend seeds once and then uses as the source of truth.

## SSH backend

Use `backend: "ssh"` to sandbox `exec`, file tools, and media reads on an arbitrary SSH-accessible machine.

The remote environment must provide `/bin/sh`, `python3`, and GNU-compatible
`stat` (`-c`) and `readlink` (`-f`, `-n`) for the filesystem bridge. These utilities
must be available to the non-interactive SSH command, not just an interactive
login shell. The Gateway host does not need these remote utilities: a macOS or
Windows Gateway can use an SSH target that supplies them. This is a remote
utility contract, not a Linux-only Gateway requirement.

Resolved workspace and parent-directory paths retain their whitespace, including
embedded and trailing newlines, during remote reads and writes.
Remove and rename operations follow in-mount parent-directory aliases while acting
on the final entry itself. Removing a final symlink leaves its target intact;
parents that resolve outside the allowed mounts are rejected.

New remote workspaces are uploaded into a private staging directory before
publication. When supported, fs-safe publishes with atomic no-replace directory
rename: `renameat2` on Linux or `renameatx_np` on macOS.

On Linux filesystems that reject `RENAME_NOREPLACE`, including gVisor volume
mounts, fs-safe checks that the destination is absent and falls back to directory
rename. This never exposes an empty claim as a completed workspace. Targets
present at the check are preserved, and file or nonempty-directory competitors
cannot be replaced. An empty directory created after that check can be replaced.
macOS still requires its native no-replace primitive. Existing remote workspaces
continue to be adopted without reseeding.

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
- **Remote workspace consequences**: the remote SSH workspace becomes the real sandbox state after the initial seed. Host-local edits made outside OpenClaw after the seed step are not visible remotely until you recreate the sandbox. `openclaw sandbox recreate` deletes the per-scope remote root and seeds again from local on next use. Browser sandboxing is not supported on this backend, and `sandbox.docker.*` settings do not apply to it.
