---
summary: "Docker-free local sandbox backend for OpenClaw built on the Anthropic Sandbox Runtime (macOS Seatbelt)."
read_when:
  - You are installing, configuring, or auditing the srt-sandbox plugin
title: "Srt Sandbox plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Docker-free local sandbox backend for OpenClaw built on the Anthropic Sandbox Runtime (macOS Seatbelt).

## Distribution

- Package: `@openclaw/srt-sandbox`
- Install route: included in OpenClaw

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

## Platform support

| Platform | Execution                                                       | Network                                                                    |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| macOS    | Seatbelt; writable scope roots and explicit readonly boundaries | Deny-all, strict domain allowlist, or open                                 |
| Linux    | Bubblewrap and required seccomp helper                          | Network namespace plus SRT proxy; per-session broker optional              |
| Windows  | Disabled with SRT 0.0.76 before native provisioning             | Every network mode rejected before account, credential, WFP or ACL changes |

`workspaceAccess: none` keeps the private sandbox workspace writable and hides the host agent workspace. `ro` denies writes to both workspaces; `rw` admits their writable files. Managed skill directories and readonly resource mounts remain protected even under a broader `writablePaths` entry. Commands, brokers and file tools use the same admitted policy. Container-style resource path projection is unsupported; configurations that require it must use a backend with that capability.

Windows settings remain accepted for configuration compatibility and read-only dependency discovery. They do not enable Windows execution. The same logical Windows scope can reuse its admitted handle; another scope, changed policy or retired generation is rejected. No handle installs, adopts or grants access to the shared sandbox account. The pinned installer can rotate shared credentials and continue elevated work after cancellation, and its cleanup API lacks a compare-owner receipt. A process-local flag or blanket uninstall cannot establish safe ownership.

Buffered commands use fresh SRT processes with the current session policy, just like streaming commands. A host guardian owns timeout, cancellation and descendant cleanup outside the guest's signaling permissions. This adds startup overhead per buffered command; the session health/control process never accepts command execution RPCs. Allowlist updates apply to subsequent commands, and concurrent commands retain separate proxies and custody owners.

Local host interpreters reject startup-hook and loader environment variables such as `BASH_ENV`, `NODE_OPTIONS`, `LD_*` and `DYLD_*` before launch. Other requested environment values remain available. Writable entries below readonly roots, and entries overlapping a hidden host workspace, are excluded before SRT constructs its platform policy.

## Native Windows qualification before enabling execution

A future backend needs an exclusive native provisioning owner with cancel-and-join authority and receipts covering account, credential, WFP, helper-path ACL and writable-root ACL state. Re-enablement requires proof on disposable Windows VMs:

1. Capture fresh-install and existing-install state, including an independent client using the shared SID.
2. Exercise repeated same-scope turns, a different concurrent scope, and two Gateway processes. Existing foreign state must fail closed without adoption or modification.
3. Retire during each asynchronous install/grant step, including delayed elevation. Await settlement and compare every persistent state item with its pre-run state. Recovery may reverse only effects proven to belong to that owner.
4. Exercise deny, allowlist, open, per-session broker and upstream-proxy settings. Unsupported combinations must reject before any persistent change.
5. Prove worker, command and descendant cleanup on success, error, timeout, cancellation, launcher/Gateway death and teardown. A restart must neither inherit stale authority nor revoke another client's grants.

<!-- openclaw-plugin-reference:manual-end -->
