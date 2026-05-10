# Polytropos Plugin Contract

This defines the *codified* expectations for plugins built in `polytropos-plugins` and loaded by OpenClaw/Polytropos.

## Artifact layout (required)

A packaged plugin artifact is produced at:

`polytropos-plugins/dist/plugins/<pluginId>/`

It must contain:

- `dist/openclaw.plugin.json`
- `dist/index.js` (or whatever `manifest.entry` points to)

## Plugin root rule (required)

**Plugin root is the directory that contains `openclaw.plugin.json`.**

In our artifact layout that is:

`polytropos-plugins/dist/plugins/<pluginId>/dist/`

The deploy tooling must always point OpenClaw at *this* directory.

## Deployment (codified)

We never manually choose the right folder.

- `scripts/deploy-plugin.mjs` must:
  1) locate the manifest
  2) validate `manifest.id === pluginId`
  3) validate `manifest.entry` exists
  4) deploy the manifest directory as plugin root

## Verification gates (codified)

Before enabling a migrated plugin:

- `pnpm verify:plugin <pluginId>` (artifact layout gate)
- `pnpm verify:doctor-plugin <pluginId>` (no OpenClaw doctor warnings for that plugin)

These gates must remain fast and deterministic.
