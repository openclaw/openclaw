# pendingFinalDelivery Live Target Note (2026.4.9)

## What is actually running

From `systemctl cat openclaw-gateway.service`:

- unit file: `/home/mertb/.config/systemd/user/openclaw-gateway.service`
- ExecStart:
  - `/home/mertb/.nvm/versions/node/v22.22.2/bin/node /home/mertb/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/index.js gateway --port 18789`

## Practical implication

The live gateway is **not** running directly from `/home/mertb/.openclaw/workspace/openclaw-src`.
It is running from the globally installed npm package under:

- `/home/mertb/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw`

## Safe deployment meaning

So the safe path is:

1. patch the matching source tree (`openclaw-src`)
2. validate with targeted tests
3. build/package from source
4. update the installed global OpenClaw package
5. restart the systemd gateway service

## Dry-run recommendation

Before any live patching:

- use `pending-final-delivery-2026.4.9-apply-commands.sh` against a clean source checkout
- confirm the build/package step for the global install path
- only then restart the real gateway service

## Why this matters

Applying a source-tree patch to the workspace repo alone will not change the currently running gateway until the global installed package is updated or replaced.
