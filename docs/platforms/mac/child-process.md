---
summary: "Gateway lifecycle on macOS (launchd + optional child process)"
read_when:
  - Integrating the mac app with the gateway lifecycle
title: "Gateway Lifecycle"
---

# Gateway lifecycle on macOS

The macOS app manages Gateway in Local mode with two strategies:

- `launchd` (default): persistent/background supervision.
- `child` (opt-in): app-spawned process that inherits OpenClaw app context.

In both modes, OpenClaw first tries to attach to an already-running Gateway on
the configured port. If attach fails, it starts/supervises according to the selected mode.

## Launchd mode (default)

- The app installs a per‑user LaunchAgent labeled `bot.molt.gateway`
  (or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` is supported).
- When Local mode is enabled, the app ensures the LaunchAgent is loaded and
  starts the Gateway if needed.
- Logs are written to the launchd gateway log path (visible in Debug Settings).
- Switching to launchd mode clears attach-only marker state automatically.

Common commands:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Replace the label with `bot.molt.<profile>` when running a named profile.

## Unsigned dev builds

`scripts/restart-mac.sh --no-sign` is for fast local builds when you don’t have
signing keys. To prevent launchd from pointing at an unsigned relay binary, it:

- Writes `~/.openclaw/disable-launchagent`.

Signed runs of `scripts/restart-mac.sh` clear this override if the marker is
present. To reset manually:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only mode

To force the macOS app to **never install or manage launchd**, launch it with
`--attach-only` (or `--no-launchd`). This sets `~/.openclaw/disable-launchagent`,
so the app only attaches to an already running Gateway. You can toggle the same
behavior in Debug Settings.

## Child mode (opt-in)

In child mode, OpenClaw spawns:

```bash
openclaw gateway --port <port> --bind <bind> --allow-unconfigured
```

with app environment and log routing to the existing gateway log path.

Lifecycle behavior:

- Before spawn, OpenClaw verifies local gateway auth config. If `gateway.auth.token`
  is missing, it restores one from launchd/env when available or generates and
  persists a new token automatically.
- Crash recovery uses bounded backoff restarts.
- After retry cap is exhausted, status moves to failed.
- Remote mode invariant still applies: remote mode never starts a local gateway.

Quit behavior in child mode:

- If child is running, app prompts on quit:
  - Stop child and quit
  - Hand off to launchd and quit
  - Cancel
- “Remember my choice” stores future quit behavior.
- Default remains “always ask”.

## Remote mode

Remote mode never starts a local Gateway. The app uses an SSH tunnel to the
remote host and connects over that tunnel.

## Why we prefer launchd

- Auto‑start at login.
- Built‑in restart/KeepAlive semantics.
- Predictable logs and supervision.

Use launchd mode when you need persistence with app closed. Use child mode when
you need process ancestry to follow the app’s macOS permission context.
