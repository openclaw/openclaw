# AGENTS.md — claworks-robot

Telegraph style. OpenClaw plugin glue for `@claworks/runtime` only.

## Boundary

- Prod code: `extensions/claworks-robot/**` + `openclaw/plugin-sdk/*` + `@claworks/runtime`.
- No `src/**` deep imports. No cross-plugin `src/**` imports.
- Other plugins: only their public `api.ts` barrel (e.g. `../memory-core/api.js`).
- Business logic lives in `packages/claworks-runtime`, not here.

## Register

- Entry: `definePluginEntry` in `index.ts`; `register()` returns early when `registrationMode !== "full"`.
- Tools: `registerCwTool` factory + `jsonResult` from `openclaw/plugin-sdk/core`.
- Service: `claworks-kernel` (`registerService` onStartup).
- HTTP: `registerHttpRoute` — `/v1`, `/studio`, `/a2a`, `/mcp`, agent card.
- Tools: `cw_*` only; manifest `contracts.tools` must match `cw-tools.ts`.
- Security: `registerSecurityAuditCollector` in `security-audit.ts`.

## Config

- Schema: `openclaw.plugin.json` `configSchema` (single source for UI).
- Types: `@claworks/runtime` `ClaworksRobotConfig`.
- Production: set `api.api_key` + `api.require_api_key`; run init with `CLAWORKS_INIT_SECURE=1`.

## Tests

- `pnpm test extensions/claworks-robot` — manifest contract + `runtime-store.test.ts`（gateway 双重 register 契约）。
- Runtime behavior: `pnpm claworks:runtime:test` + `pnpm claworks:smoke` + `pnpm claworks:gateway:e2e`.
- Process-global store: `runtime-store.ts` — `Symbol.for` 共享；`stop` 调用 `clearClaworksRobotRuntimeStore()`。
