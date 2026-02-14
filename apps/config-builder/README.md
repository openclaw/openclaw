# Config Builder (WIP)

This workspace package will host the standalone OpenClaw config builder app.

## Stack

Use the same front-end stack as the existing OpenClaw web UI (`ui/`):

- Vite
- Lit
- Plain CSS (no Next.js/Tailwind)

## Current status

Phase 0 through Phase 6 are implemented:

- app boots with Vite + Lit
- `OpenClawSchema.toJSONSchema()` runs in browser bundle
- `buildConfigSchema()` UI hints load in browser bundle
- Explorer mode supports grouped schema editing + search/filter
- Typed field renderer covers:
  - strings, numbers, integers, booleans, enums
  - primitive arrays with add/remove
  - record-like objects (key/value editor)
  - JSON fallback editor for complex array/object shapes
- Validation + error UX:
  - real-time `OpenClawSchema` validation
  - inline field-level errors
  - section-level error counts + global summary
- Wizard mode:
  - 7 curated steps with progress indicators
  - back/continue flow with shared renderer/state
- JSON5 preview panel:
  - sparse output
  - copy/download/reset
  - sensitive-value warning banner
- Routing + polish:
  - landing page + mode routing via hash (`#/`, `#/explorer`, `#/wizard`)
  - responsive layout including mobile preview drawer behavior
  - docs link in topbar
  - Vercel static config (`apps/config-builder/vercel.json`)

To run locally:

```bash
pnpm --filter @openclaw/config-builder dev
```

## Notes

Implementation details are tracked in `.local/config-builder-spec.md`.

For the spike, Vite aliases lightweight browser shims for:

- `src/version.ts`
- `src/channels/registry.ts`

This keeps schema imports browser-safe while preserving the existing Node runtime modules.
