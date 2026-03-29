# Coding Conventions

**Analysis Date:** 2026-03-28

## Naming Patterns

**Files:**

- Source files: `kebab-case.ts` (e.g., `pairing-store.ts`, `session-key.ts`)
- Test files: `<source-name>.test.ts` co-located with source
- E2E test files: `<source-name>.e2e.test.ts`
- Live/integration tests: `<source-name>.live.test.ts`
- Specialized variants use dot-separated suffixes: `pairing-store.ts`, `pairing-store.test.ts`, `pairing-messages.test.ts`
- Generated files use `.generated.ts` suffix (e.g., `bundled-channel-config-metadata.generated.ts`)
- Runtime boundary files use `.runtime.ts` suffix for lazy-loading seams

**Functions:**

- camelCase for all functions and methods: `resolveAgentRoute`, `loadConfig`, `createDefaultDeps`
- Factory functions prefixed with `create`: `createDefaultDeps`, `createTestRegistry`, `createStubPlugin`, `createTrackedTempDirs`
- Boolean predicates prefixed with `is`/`has`: `isConfigured`, `isEmbeddedPiRunActive`, `hasText`
- Resolver/normalizer functions prefixed with `resolve` or `normalize`: `resolveConfigDir`, `normalizeE164`, `resolveAgentRoute`
- Reset functions for test state suffixed with `ForTest`: `resetContextWindowCacheForTest`, `clearPairingAllowFromReadCacheForTest`
- Internal test-only exports named `__testing` (e.g., `__testing.resetSigusr1State()`)

**Variables:**

- camelCase for locals and module-level bindings
- SCREAMING_SNAKE_CASE for module-level constants: `DEFAULT_ACCOUNT_ID`, `CONFIG_DIR`, `DEVICE_BOOTSTRAP_TOKEN_TTL_MS`
- `Symbol.for(...)` keys use namespaced strings: `Symbol.for("openclaw.pluginRegistryState")`

**Types:**

- PascalCase for all types and interfaces: `OpenClawConfig`, `ChannelPlugin`, `BackoffPolicy`
- No `I` prefix for interfaces; use plain PascalCase
- Discriminated union variants: `{ ok: true; ... } | { ok: false; reason: ...; error?: ... }`
- Type suffix for complex union types: `BoundaryFileOpenResult`, `PairingSetupCommandResult`
- Module-internal types use no export; external contracts use `export type`

## Code Style

**Formatting:**

- Tool: `oxfmt` (Oxc formatter)
- Run: `pnpm format` (write), `pnpm format:check` (check)
- All TypeScript source formatted with oxfmt before commit

**Linting:**

- Tool: `oxlint` with `--type-aware` flag
- Run: `pnpm lint`
- Additional custom lint scripts in `scripts/` for boundary enforcement:
  - `scripts/check-extension-plugin-sdk-boundary.mjs`
  - `scripts/check-webhook-auth-body-order.mjs`
  - `scripts/check-no-pairing-store-group-auth.mjs`
  - `scripts/check-no-raw-channel-fetch.mjs`
- Full check: `pnpm check` (tsgo + lint + boundary checks)
- Line count guidance: ~500 LOC per file (advisory); enforced via `pnpm check:loc --max 500`
- `typescript/no-explicit-any` is enforced; disable only with `// oxlint-disable-next-line typescript/no-explicit-any` on the specific line, never file-wide

**TypeScript:**

- `strict: true` in `tsconfig.json`
- `noEmit: true` for type-checks; actual build uses tsdown
- `import type` for type-only imports: `import type { OpenClawConfig } from "../config/config.js"`
- Type assertions avoided; prefer type guards and discriminated unions
- Never use `@ts-nocheck`

## Import Organization

**Order:**

1. Node.js built-ins with `node:` prefix: `import fs from "node:fs"`, `import path from "node:path"`
2. Vitest test imports (in test files): `import { describe, expect, it, vi } from "vitest"`
3. External packages
4. Internal relative imports (deeper modules first, then local)

**Extensions:**

- All relative imports use `.js` extension even for `.ts` source files (ESM resolution):
  `import { resolveOAuthDir } from "../config/paths.js"`

**Path Aliases:**

- `openclaw/plugin-sdk` → `src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/*` → `src/plugin-sdk/*.ts`
- `openclaw/extension-api` → `src/extensionAPI.ts`
- Configured in `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`

**Barrel Files:**

- Thin re-export barrel pattern for module facades: `src/config/config.ts` simply re-exports from `./io.js`, `./types.js`, `./paths.js`, etc.
- `export *` used for type-heavy submodule re-exports
- Plugin SDK entry points in `src/plugin-sdk/` are hand-curated subpath exports, not catch-all barrels

## Error Handling

**Patterns:**

- Domain-specific Error subclasses for errors callers need to distinguish:
  - `src/infra/net/ssrf.ts`: `SsrFBlockedError`
  - `src/infra/fs-safe.ts`: `SafeOpenError`
  - `src/config/io.ts`: `ConfigRuntimeRefreshError`
  - `src/secrets/resolve.ts`: `SecretProviderResolutionError`, `SecretRefResolutionError`
  - `src/plugins/loader.ts`: `PluginLoadFailureError`
- Discriminated `Result` union pattern for recoverable outcomes (no throw):
  ```typescript
  type SomeResult =
    | { ok: true; path: string; fd: number }
    | { ok: false; reason: string; error?: unknown };
  ```
  Used extensively in `src/infra/` (e.g., `BoundaryFileOpenResult`, `PairingSetupCommandResult`)
- Callers narrow the result with `if (!result.ok)` before accessing success fields
- `safeParseJson<T>` (`src/utils.ts`) for non-throwing JSON parsing — returns `null` on error
- `try/catch` with `{ cause: err }` on re-throws to preserve error chain

## Logging

**Framework:**

- Custom logger wrapping `@clack/prompts` + subsystem-aware routing
- Entry points in `src/logger.ts`: `logInfo`, `logWarn`, `logError`, `logSuccess`, `logDebug`
- Structured file logging via `src/logging/logger.ts` with level configuration
- Subsystem prefix convention: `"subsystem: message"` auto-routes to `createSubsystemLogger`

**Patterns:**

- Use `logInfo`/`logWarn`/`logError` from `src/logger.ts` — never raw `console.log` in production paths
- Use `logDebug` (gated by `isVerbose()`) for verbose diagnostic output
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); never hand-roll spinners
- Terminal colors: use `src/terminal/palette.ts` LOBSTER_PALETTE tokens; never hardcode hex colors

## Comments

**When to Comment:**

- Tricky or non-obvious logic always gets a brief inline comment
- Pre-compiled regex constants annotated: `// Pre-compiled regex`
- Deliberate lint suppressions always have a comment explaining why
- Module-level context comments at file top for non-obvious boundaries (e.g., `src/agents/context.ts`)

**JSDoc/TSDoc:**

- Used on exported utility functions with non-obvious semantics:
  ```typescript
  /**
   * Safely parse JSON, returning null on error instead of throwing.
   */
  export function safeParseJson<T>(raw: string): T | null;
  ```
  ```typescript
  /**
   * Type guard for Record<string, unknown> ...
   */
  export function isRecord(value: unknown): value is Record<string, unknown>;
  ```
- Internal helpers generally not doc-commented; JSDoc reserved for public API surface

## Function Design

**Size:** Keep functions focused; extract helpers rather than duplicating inline. Files kept under ~500 LOC when feasible.

**Parameters:**

- Prefer a single options object parameter for functions with 3+ args:
  `function resolveAgentRoute(params: { cfg: OpenClawConfig; channel: ...; peer?: ...; }): ...`
- Optional params typed as `T | undefined` in the options object
- Default parameter values via nullish coalescing in body, not default args in signatures

**Return Values:**

- Async functions always return `Promise<T>` (no mixed sync/async)
- Functions returning discriminated results use the `{ ok: true/false }` pattern
- Type assertions (`as`) minimized; use generics and narrowing instead

## Module Design

**Exports:**

- Named exports always; no default exports except for Vitest config files
- Type-only exports use `export type` keyword (enforced by `allowImportingTsExtensions`)
- Re-export aggregation through thin barrel files (not monolithic `index.ts` dumps)

**Lazy Loading:**

- Dynamic `await import("x")` isolated to `*.runtime.ts` boundary files
- No mixing of static and dynamic imports for the same module in production paths
- Per-channel module caches in `src/cli/deps.ts` via `createLazySender`

**Dependency Injection:**

- `createDefaultDeps()` pattern in `src/cli/deps.ts` for injecting channel send functions
- Test overrides pass mock deps directly to functions; no global singleton mutation
- Internal test state exposed via `__testing` export namespace (e.g., `__testing.resetSigusr1State()`)

**Prototype Mutation:**

- Never use `applyPrototypeMixins`, `Object.defineProperty` on `.prototype`, or `Class.prototype` mutation
- Use explicit inheritance (`A extends B`) or helper composition
- Tests prefer per-instance stubs over prototype-level patching

---

_Convention analysis: 2026-03-28_
