# Gateway incident hardening

This document describes the **native incident tracking + recovery** primitives added to the OpenClaw gateway.

## Goals

- Capture actionable evidence about gateway restarts/crashes (especially fast crash→recover cycles).
- Reduce restart loops caused by non-fatal mDNS (Bonjour) lifecycle errors.
- Provide a first-party recovery command that can replace ad-hoc watchdog scripts.

## New commands

### `openclaw gateway incidents`

Show recent gateway incidents recorded on this machine.

```bash
openclaw gateway incidents --limit 100
openclaw gateway incidents --json
```

Data source (default):

- `~/.openclaw/state/gateway-incidents.jsonl`
- `~/.openclaw/state/gateway-incidents-state.json`

### `openclaw gateway recover`

Best-effort recovery helper with an anti-loop cooldown.

```bash
# default: only acts if gateway health probe fails
openclaw gateway recover

# override cooldown + force attempt
openclaw gateway recover --force --cooldown-ms 0

# JSON output for automation
openclaw gateway recover --json
```

Behavior (intentionally conservative):

- If the gateway is reachable (RPC `health` succeeds), it **does nothing**.
- If unreachable, it attempts a **service restart** via the platform service manager.
- It does **not** auto-install/uninstall the service.
- It records recovery attempts to the incident log.

## mDNS hardening: suppress `ERR_SERVER_CLOSED`

Some environments trigger a `@homebridge/ciao` timer callback after the mDNS socket has closed (send-after-close), producing:

```
ERR_SERVER_CLOSED: Cannot send packets on a closed mdns server!
```

This error is treated as **non-fatal** for OpenClaw:

- It is logged as a warning.
- The process is not terminated.

This reduces crash/restart loops during shutdown and interface churn.

## Incident log model (high level)

Incidents are written as JSONL entries, with a small state file for quick summary:

- `kind=start` (records restartCount)
- `kind=signal` (SIGTERM/SIGINT/SIGUSR1)
- `kind=crash` (uncaught exceptions)
- `kind=recover` (recover attempts)

See `docs/incident-model.md` for field-level details.

## Migration notes (from external watchdog scripts)

If you currently run a shell-script watchdog that probes the gateway and restarts it:

1. Replace the custom logic with `openclaw gateway recover --json`.
2. Schedule it via:
   - launchd/systemd timer
   - cron
   - your existing job runner

The incident log provides evidence for both:

- **Down + recovery failed** (recover command exits non-zero and records an entry)
- **Crashed but recovered** (crash entries can be correlated with the next `start` entry)
