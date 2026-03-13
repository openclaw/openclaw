---
title: "Tlon Package Migration"
summary: "Plan for migrating the Tlon plugin package from @openclaw/tlon to @tloncorp/openclaw"
read_when:
  - Updating Tlon onboarding/install metadata
  - Migrating existing Tlon plugin installs
---

# Tlon Package Migration

This document captures the OpenClaw-side plan for migrating the Tlon plugin package from
`@openclaw/tlon` to `@tloncorp/openclaw` without breaking existing installs.

## Goals

- Keep the plugin id and channel id as `tlon`.
- Switch new onboarding and docs to install `@tloncorp/openclaw`.
- Auto-migrate existing `plugins.installs.tlon` records that still point at `@openclaw/tlon`.
- Preserve version continuity on the Tlon side so pinned or version-qualified specs can move cleanly.
- Keep local checkout installs (`./extensions/tlon`) working as before.

## Required invariants

The published `@tloncorp/openclaw` package must remain a drop-in replacement for the Tlon plugin.

- `package.json.name` should be `@tloncorp/openclaw`.
- `package.json.version` should continue the existing `2026.x.y` line instead of resetting to `0.x`.
- `openclaw.channel.id` must stay `tlon`.
- `openclaw.install.npmSpec` must be `@tloncorp/openclaw`.
- `openclaw.extensions` must point at the real published entrypoint.
- `openclaw.plugin.json.id` must stay `tlon`.
- `openclaw.plugin.json.channels` must contain `tlon`.

## OpenClaw migration behavior

On config load, OpenClaw should detect old Tlon npm install specs and rewrite them in place.

- Rewrite `plugins.installs.tlon.spec` from `@openclaw/tlon` to `@tloncorp/openclaw`.
- Rewrite version-qualified specs the same way, preserving the suffix after the package name.
- Apply this to any `plugins.installs.tlon` record that still references the old package name.
- Clear stale npm resolution metadata so the next `openclaw plugins update tlon` resolves against the
  new package without comparing the old package integrity hash to the new package artifact.

Fields to clear when the spec is rewritten:

- `resolvedName`
- `resolvedVersion`
- `resolvedSpec`
- `integrity`
- `shasum`
- `resolvedAt`

Fields to preserve:

- `source`
- `installPath`
- `sourcePath`
- `version`
- `installedAt`

## Rollout

1. Publish `@tloncorp/openclaw` with the correct manifest and version continuity.
2. Update OpenClaw onboarding metadata and docs to point new installs at `@tloncorp/openclaw`.
3. Ship the config migration so existing installs start updating from the new package name.
4. Keep `@openclaw/tlon` available during the transition window.
5. Deprecate `@openclaw/tlon` after OpenClaw releases with the migration have had time to land.

## External follow-up in tloncorp/openclaw-tlon

- Publish the next `2026.x.y` version under `@tloncorp/openclaw`.
- Update the README to say the plugin is installed separately, not “included with OpenClaw”.
- Verify the published tarball contains the correct `openclaw.plugin.json`.
