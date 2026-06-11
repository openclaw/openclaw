# OpenClaw Dashboard Customization Bundle

This folder preserves the local dashboard customizations that make the Control UI
different from upstream OpenClaw.

It is intentionally local and operator-owned. The update configuration treats
these files as required paths, so one-click updates should preserve dirty local
changes and fail loudly if the dashboard customization bundle disappears.

## Regenerate

```bash
node scripts/dev/export-dashboard-customizations.mjs
```

## Verify

```bash
git apply --check --cached customizations/dashboard/openclaw-dashboard-customizations.patch
pnpm test ui/src/styles/components.test.ts ui/src/ui/views/agents-room.test.ts ui/src/ui/views/agents.test.ts
pnpm ui:build
```

## Restore

From a clean OpenClaw checkout at the matching base revision:

```bash
git apply customizations/dashboard/openclaw-dashboard-customizations.patch
```
