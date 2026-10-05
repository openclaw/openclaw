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

OpenClaw retains fs-safe's **auto** native mode on macOS, Linux, and Windows. Supported operations use the installed native helper; operations with documented JavaScript fallbacks can use those paths when native support is unavailable.

No-clobber `Root.move()` calls, including the default and `{ overwrite: false }`, require native support for an atomic no-replace rename. With native mode `off`, or a missing or unsupported helper, moving to an absent destination fails with `helper-unavailable` and leaves the source in place. A collision returns `already-exists`, preserving both the source and competing destination. A failed identity check after dispatch can still reject after the move has completed.

Doctor's legacy migration claims can use verified same-directory hardlink publication when the helper is unavailable, including native loading failures. This preserves the source identity and refuses an existing claim. Native mode `require` and mutation-specific Root policies prevent this fallback. Filesystem permission and I/O failures remain errors and do not trigger the fallback.

On Windows, secure credential reads need the matching native helper to verify ownership and ACLs on the same open file descriptor that supplies the bytes.

fs-safe publishes prebuilt native helpers as optional platform packages for Linux x64/arm64 (glibc and musl), macOS x64/arm64, and Windows x64. A normal package install selects the matching package without a compiler. OpenClaw loads it through fs-safe's own dependency scope, including nested pnpm installs. Windows secure reads fail with `permission-unverified` when the helper is missing, outdated, disabled, or unsupported; there is no pathname-based permission fallback. This includes installs that omit optional dependencies and native Windows ARM64 runtimes. File SecretRef providers and GitHub identity credentials require these secure reads.

OpenClaw leaves fs-safe's explicit environment settings and programmatic `configureFsSafeNative()` precedence unchanged:

```bash
# Guarded JavaScript paths; no-clobber moves and Windows secure reads are unavailable.
OPENCLAW_FS_SAFE_NATIVE_MODE=off

# Prefer native primitives when the installed platform helper loads.
OPENCLAW_FS_SAFE_NATIVE_MODE=auto

# Fail closed when an operation lacks the required native capability.
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

The generic fs-safe environment name also works: `FS_SAFE_NATIVE_MODE`.

[Managed worktree acceleration](/concepts/managed-worktrees#filesystem-acceleration) uses isolated native operations for APFS and Btrfs cloning and metadata reads. Those operations retain automatic native selection without changing the Gateway process's configuration. An explicit native mode applies to the isolated operations too; `off` selects normal Git checkout. Native writes remain owned by a supervised child until it exits, so cancellation cannot release the destination for cleanup while the child is still writing.

fs-safe 0.23 removes the Python bridge. OpenClaw keeps `FS_SAFE_PYTHON_MODE` and `OPENCLAW_FS_SAFE_PYTHON_MODE` as deprecated mode aliases when loading its runtime environment, with a deprecation warning. Explicit native settings and programmatic `configureFsSafeNative()` still take precedence. Replace the old names with `FS_SAFE_NATIVE_MODE` or `OPENCLAW_FS_SAFE_NATIVE_MODE`.

Python interpreter paths are not used. Remove `FS_SAFE_PYTHON`, `OPENCLAW_FS_SAFE_PYTHON`, `OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON` from deployments. Code that directly uses fs-safe must replace `configureFsSafePython` / `FsSafePythonConfig` with `configureFsSafeNative` / `FsSafeNativeConfig` and omit `pythonPath`.

Use `require` when all native-capable operations must fail if the platform binding is unavailable. `auto` allows documented JavaScript fallbacks; no-clobber Root moves and Windows secure credential reads always require their native primitives.

In fs-safe 0.21.2, `require` also refuses removal, recursive removal, directory creation, writable-open creation, and overwrite moves when the platform lacks the required confining primitive. An installed helper alone is not enough: recursive Root removal reports `helper-unavailable` on Linux without `openat2` and on Windows. These strict-mode mutations perform additional identity checks and can be slower. See the upstream [operation/platform matrix](https://github.com/openclaw/fs-safe/blob/v0.21.2/docs/security-model.md#native-root-mutation-capabilities).

Keep `require` if those native guarantees are part of your deployment's security policy, and use a platform that supports the operations you need. Otherwise, the default `auto` mode retains the documented best-effort fallbacks and their existing performance.

The Linux GNU addons in fs-safe 0.20.0 target glibc 2.28 and load on Ubuntu
20.04's glibc 2.31. Older addons can fail with a missing `GLIBC_2.33` or
`GLIBC_2.34` requirement. When a loader error reaches update diagnostics,
support reports retain the missing numeric GLIBC version while redacting paths.

Candidate update snapshots copy plugin files through fs-safe's portable
create-only publication path. They do not require a no-clobber move: copying
preserves the serving files, rejects an existing destination, and checks the
source against the admitted inventory. SQLite snapshots keep their separate
integrity, content, and publication checks. An unavailable addon alone does not
justify skipping those checks or abandoning a snapshot that can be made safely.

## Windows path boundaries

An explicitly configured UNC root, such as `\\server\share\workspace`, and
ordinary extended drive paths such as `\\?\C:\workspace` remain supported.
Existing filesystem and permission requirements for each operation still apply.

A path confined to a workspace, plugin root, or extraction destination must use
that boundary's own share. A foreign UNC share or device namespace is rejected
before lookup, even if a filesystem alias could point back inside the boundary.
Use a relative path or the admitted root's host and share spelling. Host and
share comparisons ignore ASCII case; Unicode lookalikes do not identify the same
host. OpenClaw preserves valid local plugin aliases, including short names and
trusted roots whose canonical location is a network share.

Do not strip `\\?\` or `\\.\` indiscriminately to work around a rejection.
Ambiguous namespace spellings can change which host or device Windows reaches.

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

Ordinary reads return bytes from an admitted file handle without freezing the file
against in-place writes. Writers should use atomic replacement when readers need
complete old-or-new contents. Migration and publication owners separately verify
their recorded content and ownership before removing or replacing files.

## What native acceleration adds

The native helper provides policy-free filesystem primitives. fs-safe uses them for create-only writes, guarded hard-link publication, asynchronous sidecar creation, and explicit no-replace rename publication. Linux uses `openat2` and `renameat2`. macOS uses descriptor-relative component checks and `renameatx_np`. Windows uses handle-relative operations, replacement-disabled rename, and descriptor-bound ACL inspection for secure credential reads.

The TypeScript layer still owns policy, validation, retries, cleanup, and fallback decisions. Native support narrows filesystem race windows. It does not turn fs-safe into a sandbox.

If your package deployment requires those native primitives, set:

```bash
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

In `require` mode, an unavailable or unloadable helper normally causes `helper-unavailable`; Windows secure credential reads report `permission-unverified`. Standalone sealed worker bundles have no dependency tree. They explicitly disable native loading, even when the host sets a mode override.

## Plugin and core guidance

- Plugin-facing file access should use `openclaw/plugin-sdk/*` helpers when a path comes from a message, model output, config, or plugin input. Plugins can use reviewed fs-safe primitives directly when they declare their own fs-safe dependency and retain the applicable path policy.
- Core code should import fs-safe primitives from their focused package entry points. Keep OpenClaw adapters where they own behavior, including secret-directory mode repair, archive durability, producer isolation, and public SDK compatibility. Pure re-exports are unnecessary: fs-safe owns its process defaults.
- OpenClaw's Plugin SDK retains the deprecated `nonBlockingRead` input hint for existing callers; omit it in new code. Safe reads always use nonblocking admission where supported, including when the old hint is `false`. Direct fs-safe calls no longer accept this option.
- The SDK's atomic replacement helper also retains the ignored adapter `chmod` member for source compatibility. Direct fs-safe adapters must omit it; permissions use the retained file handle.
- Archive extraction should use the fs-safe archive helpers with explicit size, entry-count, link, and destination limits.
- Secrets should use OpenClaw secret helpers or fs-safe secret/private-state helpers. Do not hand-roll mode checks around `fs.writeFile`.
- For hostile local-user isolation, do not rely on fs-safe alone. Run separate gateways under separate OS users/hosts, or use sandboxing.

Related: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing), [Exec approvals](/tools/exec-approvals), [Secrets](/gateway/secrets).
