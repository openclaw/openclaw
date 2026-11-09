# Codex live Docker security policies

This test-only profile retains Moby/Docker 28.0.4's default seccomp rules and
adds the operations Codex's native Bubblewrap sandbox needs during setup.
The live Codex wrapper uses it with a nonroot user and `no-new-privileges`.
It grants no container capabilities and does not change OpenClaw's Docker
backend or Codex's inner filesystem and network policies.

Upstream: https://github.com/moby/moby/blob/v28.0.4/profiles/seccomp/default.json

Original SHA-256: `9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76`.
The Apache-2.0 license and Moby notice are retained alongside this modified file.

The six appended rules allow five operations:

- `clone` only with `0x38020011` or `0x78020011`: `SIGCHLD`, new user, mount,
  PID, and IPC namespaces, with the second form also creating a network namespace.
- `mount`, after the new user namespace grants namespace-local authority.
- `pivot_root`, inside that new mount namespace.
- `umount2` only with `MNT_DETACH` (`2`).
- `unshare` only with `CLONE_NEWUSER` (`0x10000000`), for Bubblewrap's final UID mapping.

All original rules and the default `EPERM` action remain intact, including
restricted `clone3`, `setns`, BPF, perf, and kernel-module operations. Kernel
capability and namespace checks still apply to every allowed syscall; this
profile does not identify executable names.
When refreshing this snapshot, preserve the upstream default and revalidate both
network modes, read-only and workspace-write policies, and denied outer operations.

The AppArmor template is based on Moby 28.0.4's
[`profiles/apparmor/template.go`](https://github.com/moby/moby/blob/v28.0.4/profiles/apparmor/template.go).
It preserves the default file, signal, capability, network, and ptrace rules for
the ordinary unconfined Docker daemon used by CI. It replaces the blanket mount
denial with Bubblewrap's bind/remount, private/slave propagation, and
tmpfs/proc/devpts operations, and permits user namespaces and `pivot_root`.
The seccomp profile independently limits namespace creation; no capabilities are
added to the container.

Only disposable CI/Testbox execution loads this AppArmor template. Each run
uses a fresh profile and container name, never replaces `docker-default`, and
unloads its profile only after removing its owned container. Failed container
cleanup keeps the profile loaded; failed profile cleanup retains its recovery
file and fails the lane. The host's kernel settings are unchanged, and the
native sandbox preflight fails before provider requests if setup is unsupported.
