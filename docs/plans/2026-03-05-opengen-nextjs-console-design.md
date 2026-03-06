# OpenGen Next.js Console Design

## Overview

This design defines a one-time migration from the current static `public/index.html` + Express API entry to a unified Next.js App Router application for OpenGen.

Goals:

- Upgrade UI to an enterprise console style with stronger information hierarchy.
- Move HTTP interface to Next.js Route Handlers.
- Keep current generation capability usable during migration completion.

Chosen direction:

- Big Bang migration.
- Full-stack Next.js (`app/*` pages + `app/api/*` handlers).
- Productized multi-page console (not a single-page patch).

## Architecture

### Runtime Model

- Single Next.js process serves both frontend and API.
- Existing generation logic in `src/codegen/*` remains the domain/service layer.
- Route Handlers become the HTTP adapter layer.

### API Surface

- `POST /api/generate`
  - Keep request compatibility with current fields: `description`, `type`, `tech_stack`.
  - Return compatible task/result payload so frontend integration risk remains low.
- `GET /api/health`
  - Return status + timestamp for health probes.

### Configuration

Use existing environment variable conventions:

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- Existing fallback variables remain supported by `src/codegen/llm-client.ts`.

## Information Architecture

### Top Navigation

- `Overview`
- `Generate`
- `Tasks`
- `Settings`

### Routes

- `/` -> `Overview`
- `/generate` -> generation workspace
- `/tasks` -> task list
- `/tasks/[taskId]` -> task detail
- `/settings` -> model/config/health status

### Page Responsibilities

- `Overview`
  - system status and high-level activity summary
  - quick links to generation and task detail
- `Generate`
  - primary authoring surface
  - left panel input form, right panel structured output
- `Tasks`
  - searchable/filterable history table
  - status, type, timestamps, duration
- `Task Detail`
  - full structured `product_spec` reading view
- `Settings`
  - provider/model diagnostics and environment visibility without exposing secrets

## Interaction and State Design

### Generation State Machine

- `idle`
- `submitting`
- `success`
- `error`

### Submission Flow

1. Client-side required-field validation.
2. Call `POST /api/generate`.
3. On success:
   - render structured result sections
   - write task summary into tasks data source
4. On failure:
   - classify error type (`input`, `server`, `model`, `timeout`)
   - keep user input for retry

### Error Handling

- `400`: inline field-level or form-level guidance.
- `500`: retryable error with trace/task reference.
- timeout: actionable options (`retry`, `cancel`).

## Component and Module Boundaries

### Layering

- Page Layer: route-level composition.
- Feature Layer: generate form, result viewer, tasks table, task detail reader.
- Shared UI Layer: card, status badge, table, empty/error states.
- Data Layer: typed API client + schema validation.

### Proposed Structure

- `apps/opengen-console/app/page.tsx`
- `apps/opengen-console/app/generate/page.tsx`
- `apps/opengen-console/app/tasks/page.tsx`
- `apps/opengen-console/app/tasks/[taskId]/page.tsx`
- `apps/opengen-console/app/settings/page.tsx`
- `apps/opengen-console/app/api/generate/route.ts`
- `apps/opengen-console/app/api/health/route.ts`
- `apps/opengen-console/components/*`
- `apps/opengen-console/lib/codegen-service.ts`
- `apps/opengen-console/lib/schemas.ts`

### Legacy Boundary

- Keep `src/codegen/*` as core domain capability.
- Migrate HTTP serving responsibility from `src/codegen/server.ts` to Next.js handlers.
- `public/index.html` exits default runtime path after cutover.

## Visual and UX Direction

- Enterprise console style.
- Information-first hierarchy: summary -> stories -> features -> non-functional requirements.
- Consistent structural primitives: top header, actions area, content sections, dense data blocks.
- Mobile behavior prioritizes readability via single-column stacking without hiding key data.

## Release and Risk Plan

### Cutover

- Perform one-time entry switch to Next.js runtime.
- Keep old entry assets available for fast rollback.

### Key Risks and Controls

- API contract drift:
  - enforce compatibility in handler schema and response mapping.
- Environment/config mismatch:
  - startup health diagnostics in `Settings` + `/api/health`.
- Regression from large-scope migration:
  - staged verification checklist across routing, API, interaction, and rendering.
- Task history continuity:
  - implement minimum persistence strategy in first release.

## Validation Checklist

- All key routes reachable.
- `/api/health` returns success.
- `/api/generate` returns valid `product_spec` payload.
- Generate page supports submit/loading/success/error states correctly.
- Result readability follows section hierarchy.
- Mobile and desktop core flow both functional.
- Rollback path is documented and executable.

## Definition of Done

- User can complete: input request -> generate -> inspect task detail.
- At least one end-to-end automated verification passes.
- No blocker-level issues on key routes and APIs.
- Runtime and rollout instructions are documented and reproducible.

## Out of Scope

- Mobile native app redesign.
- Desktop app UI changes.
- Non-essential platform expansion during this migration.
