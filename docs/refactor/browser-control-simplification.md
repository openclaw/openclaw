---
summary: "Refactor: simplify browser control API + implementation"
read_when:
  - Refactoring browser control routes, client, or CLI
  - Auditing agent-facing browser tool surface
date: 2025-12-20
---

# Refactor: Browser control simplification

Goal: make the browser-control surface **small, stable, and agent-oriented**, and remove “implementation-shaped” APIs (Playwright/CDP specifics, one-off endpoints, and debugging helpers).

## Why

- The previous API accreted many narrow endpoints (`/click`, `/type`, `/press`, …) plus debug utilities.
- Some actions are inherently racy when modeled as “do X *when* the event is already visible” (file chooser, dialogs).
- We want a single, coherent contract that keeps “how it’s implemented” private.

## Target contract (vNext)

**Basics**
- `GET /` status
- `POST /start`, `POST /stop`
- `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`

**Agent actions**
- `POST /navigate` `{ url, targetId? }`
- `POST /act` `{ kind, targetId?, ... }` where `kind` is one of:
  - `click`, `type`, `press`, `hover`, `drag`, `select`, `fill`, `wait`, `resize`, `close`, `evaluate`
- `POST /screenshot` `{ targetId?, fullPage?, ref?, element?, type?, filename? }`
- `GET /snapshot` `?format=ai|aria&targetId?&limit?`
- `GET /console` `?level?&targetId?`
- `POST /pdf` `{ targetId? }`

**Hooks (pre-setup / arming)**
- `POST /hooks/file-chooser` `{ targetId?, paths, timeoutMs? }`
- `POST /hooks/dialog` `{ targetId?, accept, promptText?, timeoutMs? }`

Semantics:
- Hook endpoints **arm** the next matching event within `timeoutMs` (default 10s).
- Last arm wins per page (new arm replaces previous).

## Work checklist

- [x] Replace action endpoints with `POST /act`
- [x] Remove legacy endpoints (`/click`, `/type`, `/wait`, …) and any CLI wrappers that no longer make sense
- [x] Remove `/back` and any history-specific routes
- [x] Convert `upload` + `dialog` to hook/arming endpoints
- [x] Unify screenshots behind `POST /screenshot` (no GET variant)
- [x] Trim inspect/debug endpoints (`/query`, `/dom`) unless explicitly needed
- [x] Update docs/browser.md to describe contract without implementation details
- [x] Update tests (server + client) to cover vNext contract

## Notes / decisions

- Keep Playwright as an internal implementation detail for now.
- Prefer ref-based interactions (`aria-ref`) over coordinate-based ones.
- Keep the code split “routes vs. engine” small and obvious; avoid scattering logic across too many files.
