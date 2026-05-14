# Migration (Cutover to Polytropos core)

This document covers the **one-time** migration to enable the Polytropos release workflow on the host.

After this migration, core updates/releases are performed by running the release script, which:

- produces a `.tgz` via `npm pack`
- updates `current.tgz` / `previous.tgz`
- installs `current.tgz` globally
- stages the new code; activation is performed separately by restarting/reloading the gateway using the appropriate procedure for your environment

Dev mode (if/when needed) uses `npm link` (documented in [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)).

## Current state (reference)

On this host, the gateway service runs the installed npm package:

- `ExecStart=/usr/bin/node /home/ec2-user/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

Service file:

- `~/.config/systemd/user/openclaw-gateway.service`

## Target state

No change to `ExecStart` is required for the tarball-based release workflow.

The service continues to run the globally installed `openclaw` package; releases work by installing `current.tgz` into that global prefix.

## Migration setup (part of the task)

Set up the tarball release tree:

1. Create `~/polytropos/releases/`.

2. Ensure these symlinks exist:

- `~/polytropos/releases/current.tgz`
- `~/polytropos/releases/previous.tgz`

3. Place at least one release tarball in the directory (we can start by creating a first fork release once tags are in place).

4. Ensure the global npm prefix is known (this host uses `~/.npm-global`).

See: [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)

## Procedure (one-time migration)

1. Snapshot current unit contents (for reference/rollback):
   - `systemctl --user cat openclaw-gateway.service > ~/polytropos/gateway.service.before.txt`

2. Verify the service is healthy before proceeding:
   - `openclaw gateway status`
   - `openclaw doctor --non-interactive`

3. Create/choose an initial tarball and point `current.tgz` at it.

4. Install it globally into the same prefix the service uses:
   - `npm install -g --prefix /home/ec2-user/.npm-global ~/polytropos/releases/current.tgz`

5. Activate the staged release by restarting/reloading the gateway using the appropriate procedure for your environment.

6. Verify health:
   - `openclaw gateway status`
   - `openclaw doctor --non-interactive`

## Rollback

If there is a failure:

1. Preferred rollback (tarball flip):
   - point `current.tgz` back to `previous.tgz`
   - reinstall globally
   - restart gateway

2. Hard rollback: restore the previously installed OpenClaw version via npm (if needed).

(No unit-file rollback is required because `ExecStart` is unchanged.)
