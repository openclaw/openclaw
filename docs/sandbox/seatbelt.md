---
title: Seatbelt Sandbox Backend
summary: "Run sandboxed exec on macOS using sandbox-exec with profile-driven policy."
read_when: "You are configuring or reviewing sandbox.backend=seatbelt behavior."
status: active
---

# Seatbelt Sandbox Backend

OpenClaw supports a macOS-native sandbox backend:

- `sandbox.backend: "seatbelt"`
- execution via `sandbox-exec`
- policy via `.sb` seatbelt profiles

This backend is designed for macOS hosts where Docker is not desired for sandboxed exec.

## Config example

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "backend": "seatbelt",
        "workspaceAccess": "rw",
        "seatbelt": {
          "profile": "demo-open",
          "profileDir": "~/.openclaw/seatbelt-profiles",
          "params": {
            "EXTRA_FLAG": "1"
          }
        }
      }
    }
  }
}
```

## Runtime parameters passed to profiles

OpenClaw populates these profile params automatically:

- `PROJECT_DIR`
- `WORKSPACE_DIR`
- `STATE_DIR`
- `AGENT_ID`
- `SEATBELT_PROFILE_DIR`
- `WORKSPACE_ACCESS`
- `TMPDIR`

User-supplied `sandbox.seatbelt.params` are merged with defaults, but reserved runtime keys (`PROJECT_DIR`, `WORKSPACE_DIR`, `STATE_DIR`, `AGENT_ID`, `SEATBELT_PROFILE_DIR`, `WORKSPACE_ACCESS`, `TMPDIR`) are always enforced by OpenClaw and cannot be overridden.

## Demo profiles shipped by OpenClaw

On startup (and when seatbelt context is resolved), OpenClaw ensures demo profiles are present in the configured `profileDir`.

Installed files:

- `demo-open.sb`
- `demo-websearch.sb`
- `demo-restricted.sb`

These files are copied only when missing (never overwritten).

### Profile intent

- **demo-open**: permissive developer baseline (process + network + workspace access)
- **demo-websearch**: network-centric, denies project/state data reads/writes
- **demo-restricted**: intentionally strict profile for lock-down examples

> `demo-restricted` is intentionally hard to use as-is. Treat it as a template, not a default.

## `workspaceAccess=ro` enforcement at profile layer

`demo-restricted.sb` enforces `WORKSPACE_ACCESS` in profile policy:

- always allows `file-read*` on `PROJECT_DIR`
- allows `file-write*` on `PROJECT_DIR` only when `WORKSPACE_ACCESS == "rw"`
- denies writes when `WORKSPACE_ACCESS != "rw"` (including `ro`)

## Exec allowlist/safeBins enforcement (seatbelt)

When `exec` runs with:

- `host: "sandbox"`
- effective backend: `seatbelt`
- effective exec security: `allowlist`

OpenClaw now applies allowlist/safeBins evaluation before invoking `sandbox-exec`:

- allowlist miss => deny
- allowlist/safeBins satisfied => run enforced command plan

### Why this is seatbelt-only right now

Docker parity is intentionally deferred. Docker requires container-aware command/path resolution to avoid false negatives caused by host-vs-container path translation and mount mappings.

## Reviewer checklist (genericness)

Use this checklist in reviews:

- no hardcoded `/Users/<name>` (or other machine-specific absolute paths)
- no proxy/token assumptions in seatbelt runtime path
- no internal role-name coupling in profile logic
- profiles use params (`PROJECT_DIR`, `STATE_DIR`, `AGENT_ID`, `SEATBELT_PROFILE_DIR`, `WORKSPACE_ACCESS`)
- session access rules are generic (`${STATE_DIR}/agents/...` style)
- seatbelt allowlist enforcement is explicit; docker defer rationale is documented
