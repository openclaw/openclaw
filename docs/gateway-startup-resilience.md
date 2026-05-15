# Gateway startup resilience

OpenClaw writes a safe, secret-free startup runtime state file to the active state directory:

```text
~/.openclaw/gateway-startup-runtime.json
```

Use:

```sh
openclaw gateway startup-doctor --json
```

to inspect local startup state. The doctor separates configured/default CLI-process state from runtime-detected gateway state.

## Safe mode

Safe mode starts the local gateway/control UI while skipping provider/channel/plugin side effects that are expensive or network-facing:

```sh
openclaw gateway run --safe-mode
```

Safe mode sets runtime skip flags for providers/channels, Bonjour, and startup model-pricing refresh. The startup log includes explicit safe-mode messages.

## Runtime-state fields

The runtime-state JSON intentionally avoids secrets and raw configuration values. Important fields include:

- `safeMode` — whether the running gateway was started in safe mode.
- `startupPhase` — latest coarse startup phase written by the gateway.
- `pluginsLoaded` — number of startup plugins loaded.
- `providersSkipped` / `channelsSkipped` — whether provider/channel startup was skipped.
- `channelsAttempted` — number of channel plugins attempted in normal mode.
- `channelsStarted` — channel plugins that completed startup handoff.
- `channelsFailed` — channel plugins that failed during startup.
- `channelsTimedOut` — channel plugins that exceeded the startup timeout boundary.
- `channelResults` — per-channel safe summaries with `id`, `status`, optional duration, and sanitized error text.
- `bonjourDisabled` — whether Bonjour/mDNS was disabled by startup mode/config.
- `modelPricingStartupDisabled` — whether startup model-pricing refresh was disabled.
- `startupDurationMs` — elapsed startup duration at the last write.
- `warnings` / `errors` — bounded, sanitized startup summaries.

## Channel startup timeout

Normal mode still attempts channel startup, but each channel startup is bounded so one slow channel cannot make gateway readiness opaque indefinitely.

The default timeout is conservative. For tests or local diagnostics, it can be overridden with:

```sh
OPENCLAW_CHANNEL_STARTUP_TIMEOUT_MS=5000 openclaw gateway run
```

Timeouts are recorded in startup runtime state and surfaced by `startup-doctor --json`.
