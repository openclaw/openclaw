---
summary: "CLI reference for `openclaw init` (opt-in teammate worker computer)"
read_when:
  - You want a persistent worker computer instead of gateway-as-computer
  - You are splitting Gateway from exec/browser/computer
  - You are upgrading a Coolify gateway-is-computer install
title: "Init CLI"
status: active
---

# `openclaw init`

`openclaw init --mode teammate` is the opt-in first-run for a **persistent
worker computer** shared by named Bots. Bare `openclaw init` does not default
to teammate mode. Existing installs are not rewritten.

Closing Control UI does not stop a turn or a routine; the worker disk is the
computer.

This does not require Cursor or xAI login. Bring your own models.

## Commands

```bash
openclaw init --mode teammate
openclaw init --mode teammate --backend docker
openclaw init --mode teammate --backend openshell
openclaw init --mode teammate --backend firecracker
openclaw init --mode teammate --json
```

`--backend firecracker` is gated (Kata/Firecracker OCI runtime). Docker is the
default. Confirm exec is off the gateway host:

```bash
openclaw sandbox explain --json
```

The JSON payload includes `exec.effectiveHost` and `exec.gatewayExec`. Teammate
mode expects `gatewayExec: false`.

## Related

- [`setup`](/cli/setup) — system-agent chat and onboarding fallback
- [`sandbox`](/cli/sandbox) — inspect effective sandbox and exec placement
- [Teammate mode](/gateway/teammate-mode) — Coolify gateway-is-computer vs true split
