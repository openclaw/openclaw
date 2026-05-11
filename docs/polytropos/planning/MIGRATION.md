# Migration (Cutover to Polytropos core)

This document covers the **one-time** migration to run the gateway from the Polytropos release tree:

- `~/polytropos/releases/current/index.js`

After this migration, core updates/releases are performed by running the release script and flipping the `current/previous` symlinks (see `docs/polytropos/CORE-RELEASES.md`).

## Current state (reference)

On this host, the gateway service currently runs the installed npm package:

- `ExecStart=/usr/bin/node /home/ec2-user/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

Service file:

- `~/.config/systemd/user/openclaw-gateway.service`

## Target state

Update `ExecStart` to:

- `ExecStart=/usr/bin/node /home/ec2-user/polytropos/releases/current/index.js gateway --port 18789`

## Migration setup (part of the task)

Before changing `ExecStart`, complete the release tree setup:

1) Create `~/polytropos/releases/` and ensure these entries exist:
   - `current` (symlink)
   - `previous` (symlink)
   - `dev` (symlink)

2) Ensure `current` points to a runnable release directory containing `index.js`.

3) Ensure `previous` points to a known-good runnable release directory (rollback target).

4) Verify the entrypoint exists:

   - `test -f ~/polytropos/releases/current/index.js`

For the canonical definition of a release directory and symlink semantics, see:

- [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)

## Procedure (one-time cutover)

0) Snapshot current unit contents for rollback:

   - `systemctl --user cat openclaw-gateway.service > ~/polytropos/gateway.service.before.txt`

1) Stop gateway (brief downtime):

   - `systemctl --user stop openclaw-gateway`

2) Edit service file in place (single change to `ExecStart`).

   Change from:

   - `/usr/bin/node /home/ec2-user/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

   To:

   - `/usr/bin/node /home/ec2-user/polytropos/releases/current/index.js gateway --port 18789`

3) Reload systemd user units:

   - `systemctl --user daemon-reload`

4) Start gateway:

   - `systemctl --user start openclaw-gateway`

5) Verify health:

   - `openclaw gateway status`
   - `openclaw doctor --non-interactive`

6) Verify the gateway is actually running the new entrypoint:

   - `systemctl --user show openclaw-gateway -p ExecStart`

7) (Optional) If restart-resume is configured, confirm it still runs (it uses ExecStartPre).

## Rollback

If there is a failure:

1) Preferred rollback (symlink flip):
   - point `current` back to `previous`
   - restart gateway

2) Hard rollback (unit revert):
   - restore `ExecStart` to the prior installed-package path
   - or restore from `~/polytropos/gateway.service.before.txt`
   - restart gateway
