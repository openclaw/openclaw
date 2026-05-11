# Polytropos Core Cutover (Gateway ExecStart)

This document covers the **one-time** operational change to point the running gateway systemd unit at the Polytropos `~/polytropos/releases/current/index.js` entrypoint.

This is intentionally documented outside of `CORE-RELEASES.md` because it is not part of the normal release procedure; it is a one-time cutover.

## Current state (reference)

On this host, the gateway service currently runs the installed npm package:

- `ExecStart=/usr/bin/node /home/ec2-user/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

Service file:

- `~/.config/systemd/user/openclaw-gateway.service`

## Target state

Update `ExecStart` to:

- `ExecStart=/usr/bin/node /home/ec2-user/polytropos/releases/current/index.js gateway --port 18789`

## Migration setup (part of the task)

Before changing `ExecStart`, ensure:

- `~/polytropos/releases/current` exists and points at a valid release directory
- `~/polytropos/releases/previous` exists and points at a known-good release directory
- `~/polytropos/releases/current/index.js` exists

(See `CORE-RELEASES.md` for how to create releases and maintain `previous/current/dev`.)

## Procedure (one-time cutover)

1) Stop gateway (brief downtime):

   - `systemctl --user stop openclaw-gateway`

2) Edit service file in place (single change to ExecStart).

3) Reload systemd user units:

   - `systemctl --user daemon-reload`

4) Start gateway:

   - `systemctl --user start openclaw-gateway`

5) Verify:

   - `openclaw gateway status`
   - `openclaw doctor --non-interactive`

## Rollback

If there is a failure:

1) Preferred rollback: flip `current` back to the known-good release (or to `previous`) and restart the gateway.
2) Hard rollback: revert `ExecStart` to the prior installed-package path and restart.
