# Gateway startup resilience

OpenClaw writes a safe startup runtime state file to the active state directory:

```text
~/.openclaw/gateway-startup-runtime.json
```

Use:

```sh
openclaw gateway startup-doctor --json
```

to inspect local startup state. `startup-doctor` does **not** read `openclaw.json`; it relies on the runtime-state file plus lightweight local probes. If runtime state is missing, unknown fields are reported as `null`/empty and `readiness.fullyReady` is `false`.

## Safe mode

Safe mode starts the local gateway/control UI while skipping provider/channel/plugin side effects that are expensive or network-facing:

```sh
openclaw gateway run --safe-mode
```

Safe mode sets runtime skip flags for providers/channels, Bonjour, and startup model-pricing refresh. The startup log includes explicit safe-mode messages. In safe mode, machine consumers should still inspect `readiness` and skip flags rather than assuming normal-mode channel readiness.

## Runtime-state safety

The runtime-state JSON intentionally avoids secrets and raw configuration values. Startup diagnostic strings are redacted before persistence and then truncated. Redaction covers common token/password fragments, bearer tokens, credentialed URLs, connection-string passwords, JWT-like values, and accidental config/openclaw.json fragments.

## Runtime-state fields

Important fields include:

- `safeMode` — whether the running gateway was started in safe mode.
- `startupPhase` — latest coarse startup phase written by the gateway.
- `pluginsLoaded` — number of startup plugins loaded.
- `providersSkipped` / `channelsSkipped` — whether provider/channel startup was skipped.
- `channelsAttempted` — number of channel plugins attempted in normal mode.
- `channelsStarted` — channel plugins that completed startup handoff without immediate startup failure.
- `channelsFailed` — channel plugins that failed during startup.
- `channelsTimedOut` — channel plugins that exceeded the startup timeout boundary.
- `channelResults` — per-channel safe summaries with `id`, `status`, optional duration, and redacted error text.
- `bonjourDisabled` — whether Bonjour/mDNS was disabled by startup mode/config.
- `modelPricingStartupDisabled` — whether startup model-pricing refresh was disabled.
- `startupDurationMs` — elapsed startup duration at the last write.
- `warnings` / `errors` — bounded, redacted startup summaries.

## Readiness semantics

`startup-doctor --json` includes explicit readiness fields:

```ts
type GatewayStartupReadiness = {
  httpReady: boolean;
  sidecarsReady: boolean;
  fullyReady: boolean;
  phase: string;
  message: string;
};
```

Startup phases include:

- `starting` — gateway startup has begun.
- `plugins-bootstrapped` — startup plugin planning/bootstrap has completed.
- `http-ready` — HTTP/control UI is available, but sidecars/channels may still be starting.
- `sidecars-ready` — sidecars/channels have completed or were skipped.
- `ready` — gateway startup has completed its ready transition.

`http-ready` is **not** full readiness. Machine consumers should use `readiness.fullyReady`, not `httpHealthy` alone. Channel failures and timeouts remain visible in the channel summary and readiness message.

## Channel startup timeout

Normal mode still attempts channel startup, but each channel startup is bounded so one slow channel cannot make gateway readiness opaque indefinitely.

The default timeout is conservative. For tests or local diagnostics, it can be overridden with:

```sh
OPENCLAW_CHANNEL_STARTUP_TIMEOUT_MS=5000 openclaw gateway run
```

A timed-out startup is recorded as `timed_out`. If a channel startup task cannot be cancelled safely, it may continue in the background; the timeout means gateway startup observability is no longer blocked waiting for it.
