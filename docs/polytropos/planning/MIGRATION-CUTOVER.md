# Polytropos Core Cutover (Gateway ExecStart)

This document captures the one-time operational change required to switch the running gateway from the installed OpenClaw package to the Polytropos core release symlink.

## Goal

- Make a **single** update to the gateway systemd unit so it executes the core from:
  - `~/polytropos/releases/current/index.js`
- After cutover, core version changes are performed by updating the `current` symlink (see `docs/polytropos/CORE-RELEASES.md`).

## Current state (reference)

On this host, the gateway service currently runs the installed npm package:

- `ExecStart=/usr/bin/node /home/ec2-user/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

Service file:

- `~/.config/systemd/user/openclaw-gateway.service`

## Target state

Update `ExecStart` to:

- `ExecStart=/usr/bin/node /home/ec2-user/polytropos/releases/current/index.js gateway --port 18789`

## Migration setup (part of the task)

Before changing `ExecStart`, perform the initial release setup described in:

- `docs/polytropos/CORE-RELEASES.md`

Minimum setup required:

- create `~/polytropos/releases/<version>/` as a byte-for-byte copy of the currently installed OpenClaw `dist/` directory
- set `~/polytropos/releases/current` to point at that release

## Procedure (one-time cutover)

1) Ensure `~/polytropos/releases/current/index.js` exists.

2) Stop gateway (brief downtime):

   - `systemctl --user stop openclaw-gateway`

3) Edit service file in place (single change to ExecStart).

4) Reload systemd user units:

   - `systemctl --user daemon-reload`

5) Start gateway:

   - `systemctl --user start openclaw-gateway`

6) Verify:

   - `openclaw gateway status`
   - `openclaw doctor --non-interactive`

## Rollback

If there is a failure:

1) **Preferred rollback (symlink flip):** during setup, ensure you keep a known-good release available (e.g. `~/polytropos/releases/<known-good>/`) and optionally a `previous` symlink. Then rollback by flipping `current` back to the known-good release and restarting the gateway.

2) **Hard rollback (service ExecStart revert):** revert `ExecStart` to the prior installed-package path and restart.
