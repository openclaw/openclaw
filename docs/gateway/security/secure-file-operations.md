---
summary: "How OpenClaw handles local file access safely, including native Windows credential checks"
read_when:
  - Changing file access, archive extraction, workspace storage, or plugin filesystem helpers
title: "Secure file operations"
---

OpenClaw uses [`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe) for security-sensitive local file operations: root-bounded reads/writes, atomic replacement, archive extraction, temp workspaces, JSON state, and secret-file handling.

It is a **library guardrail** for trusted OpenClaw code that receives untrusted path names, not a sandbox. Host filesystem permissions, OS users, containers, and the agent/tool policy still define the real blast radius.

<a id="default-javascript-fallback" />

## Platform defaults

OpenClaw sets fs-safe's native helper to **off** by default on macOS and Linux. Guarded JavaScript paths support normal filesystem operations there and keep runtime behavior deterministic across desktop, Docker, CI, and bundled-app environments.

On Windows, OpenClaw retains fs-safe's **auto** default. Secure credential reads need the matching native helper to verify ownership and ACLs on the same open file descriptor that supplies the bytes. This also enables other fs-safe native operations when the Windows helper is available.

fs-safe publishes prebuilt native helpers as optional platform packages for Linux x64/arm64 (glibc and musl), macOS x64/arm64, and Windows x64. A normal package install selects the matching package without a compiler. OpenClaw loads it through fs-safe's own dependency scope, including nested pnpm installs. Windows secure reads fail with `permission-unverified` when the helper is missing, outdated, disabled, or unsupported; there is no pathname-based permission fallback. This includes installs that omit optional dependencies and native Windows ARM64 runtimes. File SecretRef providers and GitHub identity credentials require these secure reads. Other operations retain their documented JavaScript fallback when native support is unavailable in `auto` mode.

Managed worktree acceleration uses isolated native helpers for APFS and Btrfs, without enabling native primitives in the Gateway process. These helpers use fs-safe's automatic native selection and honor the explicit mode settings below. See [Managed worktrees](/concepts/managed-worktrees#filesystem-acceleration).

OpenClaw only changes the _default_. An explicit setting always wins:

```bash
# Guarded JavaScript paths; Windows secure credential reads become unavailable.
OPENCLAW_FS_SAFE_NATIVE_MODE=off

# Prefer native primitives when the installed platform helper loads.
OPENCLAW_FS_SAFE_NATIVE_MODE=auto

# Fail closed when an operation needs native support and the binding is unavailable.
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

The generic fs-safe environment name also works: `FS_SAFE_NATIVE_MODE`.

[Managed worktree acceleration](/concepts/managed-worktrees#filesystem-acceleration) uses isolated native operations for APFS and Btrfs cloning and metadata reads. Those operations use an available platform binding by default without enabling native helpers in the Gateway process. An explicit native mode applies to the isolated operations too; `off` selects normal Git checkout. Native writes remain owned by a supervised child until it exits, so cancellation cannot release the destination for cleanup while the child is still writing.

fs-safe still maps the retired `FS_SAFE_PYTHON_MODE` and `OPENCLAW_FS_SAFE_PYTHON_MODE` values to native modes with a deprecation warning. Replace them with `FS_SAFE_NATIVE_MODE` or `OPENCLAW_FS_SAFE_NATIVE_MODE`. Python interpreter path settings are no longer used.

Use `require` when all native-capable operations must fail if the platform binding is unavailable. `auto` allows documented JavaScript fallbacks; Windows secure credential reads always require descriptor-bound native verification.

## What stays protected without native acceleration

With the helper off, OpenClaw still gets fs-safe's Node-only guardrails:

- rejects relative-path escapes (`..`), absolute paths, and path separators where only bare names are allowed.
- resolves operations through a trusted root handle instead of ad-hoc `path.resolve(...).startsWith(...)` checks.
- refuses symlink and hardlink patterns on APIs that require that policy.
- opens files with identity checks where the API returns or consumes file contents.
- writes state/config files via atomic sibling-temp + rename.
- enforces byte limits for reads and archive extraction.
- applies private file modes for secrets and state files where the API requires them.

This covers OpenClaw's normal threat model: trusted gateway code handling untrusted model/plugin/channel path input inside a single trusted operator boundary.

## What native acceleration adds

The native helper provides policy-free filesystem primitives. fs-safe uses them for create-only writes, guarded hard-link publication, asynchronous sidecar creation, and explicit no-replace rename publication. Linux uses `openat2` and `renameat2`. macOS uses descriptor-relative component checks and `renameatx_np`. Windows uses handle-relative operations, replacement-disabled rename, and descriptor-bound ACL inspection for secure credential reads.

The TypeScript layer still owns policy, validation, retries, cleanup, and fallback decisions. Native support narrows filesystem race windows. It does not turn fs-safe into a sandbox.

If your package deployment requires those native primitives, set:

```bash
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

In `require` mode, an unavailable or unloadable helper normally causes `helper-unavailable`; Windows secure credential reads report `permission-unverified`. Standalone sealed worker bundles have no dependency tree. They explicitly disable native loading, even when the host sets a mode override.

## Plugin and core guidance

- Plugin-facing file access should go through `openclaw/plugin-sdk/*` helpers, not raw `fs`. This applies when a path comes from a message, model output, config, or plugin input.
- Core code should use the fs-safe wrappers under `src/infra/*` so OpenClaw's process policy applies consistently.
- Archive extraction should use the fs-safe archive helpers with explicit size, entry-count, link, and destination limits.
- Secrets should use OpenClaw secret helpers or fs-safe secret/private-state helpers. Do not hand-roll mode checks around `fs.writeFile`.
- For hostile local-user isolation, do not rely on fs-safe alone. Run separate gateways under separate OS users/hosts, or use sandboxing.

Related: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing), [Exec approvals](/tools/exec-approvals), [Secrets](/gateway/secrets).
