# Architecture

This monorepo hosts a Remotion-based video studio composed of apps, shared packages, and tooling.

## Monorepo Layout

- `apps/`
  - Application projects and templates (`_template`, `3D-template`, examples).
- `packages/`
  - Shared libraries under `@studio/*`:
    - `@studio/core-types`
    - `@studio/timing`
    - `@studio/hooks`
    - `@studio/easings`
    - `@studio/transitions`
- `scripts/`
  - Dev tooling (`create-project`, `render-app`, `upgrade-remotion`, etc.).
- `docs/`
  - Documentation.

## Responsibilities

- `@studio/core-types`: Shared type definitions.
- `@studio/timing`: Frame/time helpers and timing utilities.
- `@studio/hooks`: Shared Remotion-oriented React hooks.
- `@studio/easings`: Easing functions and cubic-bezier helpers.
- `@studio/transitions`: Reusable transition components.

## Dependency Graph

```mermaid
graph TD
  CT[@studio/core-types]
  TM[@studio/timing]
  HK[@studio/hooks]
  ES[@studio/easings]
  TR[@studio/transitions]
  Apps[apps/*]

  TM --> CT
  HK --> CT
  TR --> CT
  ES --> CT

  Apps --> TM
  Apps --> HK
  Apps --> ES
  Apps --> TR
```

## Build & Render Flow

- Type-check/build packages with `pnpm -r build`.
- Apps import packages via `@studio/*` aliases (Webpack alias resolves to `packages/*/src`).
- Rendering uses Remotion CLI; `scripts/render-app.ts` orchestrates app/composition rendering from the monorepo root.
