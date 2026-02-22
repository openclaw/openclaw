# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Governance baseline for best-in-class implementation program:
  - Engineering docs structure under `docs/engineering/`.
  - Runbooks for gateway outage, provider outage, DB migration, and CI breakage.
  - PR template with required changelog/verification/rollback checklist.
- CI quality gates:
  - Scroll/chat layout audit integration.
  - API contract smoke test integration.
  - Chat UX/API smoke test integration.
  - Documentation change enforcement gate.
- Baseline audit tooling and report generation.
- Database migration framework contract with `schema_migrations`.
- Workspace-aware activity API filtering and validation (`workspace_id`, `limit`, `type`).
- Chat transcript windowing for long sessions:
  - Incremental "Load older messages" control.
  - Scroll-anchor preservation when prepending older messages.
  - Deterministic chat composer test anchor (`data-testid="mc-chat-composer"`).
- Mission Control follow-up UX/design audit report for full-view desktop/mobile sweep:
  - `docs/engineering/AUDIT-UX-DESIGN-FOLLOWUP-2026-02-19.md`.
- Dedicated `MCP Servers` dashboard view:
  - New page component at `src/components/views/mcp-servers-view.tsx`.
  - Live inventory from `/api/plugins` with server-type, plugin origin, version, scope, search, and refresh.

### Changed
- API middleware and shared error handling aligned to a standardized error envelope and request correlation headers.
- CI workflow expanded from lint/build-only to full wave-0 gates.
- `docs:gate` now evaluates commit diff + staged/unstaged/untracked changes, so local enforcement matches real workspace state.
- Gateway-dependent read APIs now degrade gracefully with `degraded` + `warning` payloads instead of hard 500s:
  - `/api/agents`
  - `/api/models`
  - `/api/chat/sessions`
  - `/api/chat` (history path)
  - `/api/openclaw/config`
  - `/api/openclaw/cron` (GET)
  - `/api/openclaw/logs`
  - `/api/openclaw/sessions`
  - `/api/openclaw/status`
  - `/api/openclaw/usage`
  - `/api/openclaw/connectivity`
- Specialists and task monitor routes now use standardized error handling (`handleApiError`).
- Event-driven refresh behavior tuned to reduce fetch storms:
  - Ignore high-frequency `chat.delta` events in board/activity polling synchronizer.
  - Throttle task-detail comment refreshes and scope them to task-relevant events.
  - Scope activity feed fetches by active workspace.
- Sidebar now defaults to expanded on first load for better view discoverability (users can still collapse and preference persists).
- Baseline audit probes now include workspace-scoped routes for tasks/missions and emit `workspaceId` in the report payload.
- `All Tools` route wiring now uses strongly typed `ViewId` navigation and includes explicit `mcp-servers` mapping.
- Sidebar routing whitelist (`VALID_VIEWS`) now includes `mcp-servers`, with advanced navigation entry support.
- API contract CI now enforces `RISK_LEVEL=medium` during smoke runs to keep auth/contract expectations deterministic.
- API contract smoke runner now authenticates `/api/csrf-token` bootstrap requests when API key auth is enabled.

### Fixed
- Route-level request correlation and header consistency across guarded API paths.
- Legacy SQLite bootstrap failure where schema initialization attempted to create `idx_activity_workspace` before `workspace_id` existed on `activity_log`.
- `workspace_id` migration now runs reliably on existing databases, resolving `no such column: workspace_id` failures in tasks/missions/activity APIs.
- Excessive request churn from task detail modal refresh loops during gateway event bursts.
- Chat long-history UX drift by preserving user scroll position when loading earlier messages.
- Icon-only and toggle controls now expose accessible names/semantics across key views:
  - terminal close, quick actions launcher, notifications shortcut, learning-hub source link, chat send button, channels refresh button, settings toggles (`role=\"switch\"` + `aria-checked`).
- False-negative baseline failures where `/api/tasks` and `/api/missions` were audited without required `workspace_id`.
- Dashboard board-view hydration mismatch warning resolved by normalizing stat-card icon class serialization.
- Remaining hook/settings/plugins lint blockers removed (React hooks purity/set-state/static-component + `no-explicit-any`) to restore clean lint baseline.
- View integrity revalidated for previously reported missing pages (`Employees`, `All Tools`) on non-3000 endpoints.
- Scroll/chat audit flake reduced by waiting for scroll-root + stylesheet readiness before collecting viewport metrics.
- Restored `Employees` organizational chart rendering in the main employees view (replacing placeholder copy with live hierarchy tree, filtering, and cycle/depth safeguards).
- Fixed `All Tools` card routing regressions where `Plugin Registry` and `MCP Servers` cards could route to the wrong destination.
- Removed incompatible `ajv` package override that broke ESLint runtime (`Cannot find module 'ajv/dist/compile/codegen'` / v6-v8 mismatch).
- Dashboard stat cards now use `/api/health?soft=true` (always-200 soft mode) to prevent recurring degraded-health 503 noise in browser diagnostics.
- Fixed system-health uptime display mismatch by accepting `uptime` payloads from `/api/health` (previously typed as `uptime_seconds` only).

### Security
- Hardened API contract enforcement for auth/CSRF/rate-limit failures with consistent machine-readable error responses.
- Reduced raw gateway error leakage in health/connectivity responses.

### Deprecated
- None.
