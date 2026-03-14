# Coding Conventions

**Analysis Date:** 2026-03-08

## Naming Patterns

**Files:**
- Use kebab-case for all TypeScript source files: `abort-signal.ts`, `resolve-route.ts`, `auth-profiles.ts`
- Test files use `.test.ts` suffix co-located with source: `logger.ts` / `logger.test.ts`
- E2E tests use `.e2e.test.ts` suffix: `docker-setup.e2e.test.ts`
- Live tests use `.live.test.ts` suffix: `anthropic.setup-token.live.test.ts`
- Guardrail tests use `.guardrail.test.ts` suffix: `acp-binding-architecture.guardrail.test.ts`
- Test names may include dotted sub-topic for granular suites: `auth-profiles.resolve-auth-profile-order.uses-stored-profiles-no-config-exists.test.ts`
- Config/type re-export barrels: `config.ts`, `types.ts`

**Functions:**
- Use camelCase: `resolveAgentRoute`, `logWithSubsystem`, `createStubPlugin`
- Factory functions use `create` prefix: `createTestRegistry`, `createTempHomeEnv`, `createFixtureSuite`
- Boolean getters use `is` prefix: `isVerbose()`, `isYes()`, `isRich()`
- Setters use `set` prefix: `setVerbose()`, `setYes()`

**Variables:**
- Use camelCase for local variables and parameters
- Use UPPER_SNAKE_CASE for module-level constants: `DEFAULT_MAX_ARCHIVE_BYTES_ZIP`, `LOBSTER_PALETTE`, `TEST_PROCESS_MAX_LISTENERS`
- Regex patterns as module constants: `const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;`

**Types:**
- Use PascalCase for types and interfaces: `ArchiveKind`, `ChannelPlugin`, `OpenClawConfig`
- Type aliases use `type` keyword (not `interface`): `type LogMethod = "info" | "warn" | "error";`
- Export types separately with `export type`: `export type { ChannelPlugin } from "./types.plugin.js";`
- Error code unions use string literal types: `type ArchiveSecurityErrorCode = "destination-not-directory" | "destination-symlink" | ...`

## Code Style

**Formatting:**
- Tool: **Oxfmt** (not Prettier)
- Run: `pnpm format` (check), `pnpm format:fix` (write)
- Config: managed by oxfmt defaults

**Linting:**
- Tool: **Oxlint** (not ESLint) with type-aware mode
- Config: `.oxlintrc.json`
- Run: `pnpm lint` (runs `oxlint --type-aware`)
- Full check: `pnpm check` (runs format check, tsgo, lint, plus custom boundary lint scripts)
- Plugins enabled: `unicorn`, `typescript`, `oxc`
- Categories at error level: `correctness`, `perf`, `suspicious`
- Key enforced rule: `typescript/no-explicit-any` is `error` -- never add `@ts-nocheck` or disable this rule
- Inline suppression syntax: `// oxlint-disable-next-line typescript/no-explicit-any` (not eslint-disable)

**Type Checking:**
- Tool: **tsgo** (Go-based TypeScript checker, not `tsc`)
- Run: `pnpm tsgo`
- Config: `tsconfig.json` with `strict: true`, target `es2023`, module `NodeNext`

## Import Organization

**Order:**
1. Node built-in modules (`node:fs`, `node:path`, `node:os`, `node:url`)
2. External dependencies (`vitest`, `jszip`, `tar`, `chalk`)
3. Internal absolute/aliased imports (`../config/config.js`, `./globals.js`)

**Path Style:**
- Always use `.js` extensions in import paths (ESM requirement): `import { logInfo } from "./logger.js";`
- Use `node:` prefix for Node built-ins: `import fs from "node:fs/promises";`
- Type-only imports use `import type`: `import type { OpenClawConfig } from "../config/config.js";`
- Barrel re-exports use `export * from` or explicit named re-exports

**Path Aliases:**
- `openclaw/plugin-sdk` resolves to `src/plugin-sdk/index.ts` (configured in `tsconfig.json` paths and `vitest.config.ts` aliases)
- `openclaw/plugin-sdk/<subpath>` resolves to `src/plugin-sdk/<subpath>.ts`

## Error Handling

**Patterns:**
- Custom error classes extend `Error` with a typed `code` property:
  ```typescript
  export class ArchiveSecurityError extends Error {
    code: ArchiveSecurityErrorCode;
    constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions) {
      super(message, options);
      this.code = code;
      this.name = "ArchiveSecurityError";
    }
  }
  ```
- Empty catch blocks for non-critical failures use `catch { }` (no variable binding):
  ```typescript
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  ```
- Async error propagation uses standard `await`/`try`/`catch`
- AbortSignal pattern for cancellation: `src/infra/abort-signal.ts`

## Logging

**Framework:** Custom logging subsystem (`src/logging/`)

**Patterns:**
- Use `logInfo()`, `logWarn()`, `logError()`, `logSuccess()`, `logDebug()` from `src/logger.ts`
- Subsystem-prefixed messages route automatically: `"discord: connection lost"` -> discord subsystem logger
- Verbose/debug output: `logVerbose()` from `src/globals.ts` (only prints when verbose enabled)
- File logging via `src/logging/logger.ts` with daily rolling log files
- Colors use the shared theme from `src/terminal/theme.ts` (wraps `src/terminal/palette.ts`)
- Never hardcode ANSI colors; use `theme.*` accessors: `theme.success(msg)`, `theme.error(msg)`, `theme.muted(msg)`

## Comments

**When to Comment:**
- Add brief comments for tricky or non-obvious logic
- Use `/** @internal */` JSDoc for internal-only exports: `/** @internal */ export const DEFAULT_MAX_ENTRIES = 50_000;`
- Security/architecture comments explain "why" not "what"

**JSDoc/TSDoc:**
- Use JSDoc `/** */` for exported constants and types that need documentation
- Inline `//` comments for implementation notes
- Multi-line block comments for complex explanations

## Function Design

**Size:** Keep files under ~500 LOC; split/refactor when larger. Guideline of ~700 LOC max.

**Parameters:** Prefer named parameter objects for functions with 3+ parameters:
```typescript
function logWithSubsystem(params: {
  message: string;
  runtime: RuntimeEnv;
  runtimeMethod: RuntimeMethod;
  runtimeFormatter: (value: string) => string;
  loggerMethod: LogMethod;
  subsystemMethod: LogMethod;
}) { ... }
```

**Return Values:** Explicit return types on public APIs; inferred for internal helpers.

## Module Design

**Exports:**
- Named exports preferred over default exports
- Re-export barrels for public API surfaces: `src/config/config.ts`, `src/channels/plugins/types.ts`
- Type re-exports use `export type { ... } from ...`
- Export `*` for types-only modules; explicit named exports for modules with logic

**Barrel Files:**
- Used for config, types, and plugin-sdk subpaths
- Pattern: re-export from implementation files with explicit names

**Dynamic Imports:**
- Do not mix `await import("x")` and static `import ... from "x"` for the same module
- Create dedicated `*.runtime.ts` boundary for lazy loading
- After refactors, run `pnpm build` and check for `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings

## Class Design

- Never share class behavior via prototype mutation
- Use explicit inheritance/composition (`A extends B extends C`)
- In tests, prefer per-instance stubs over `SomeClass.prototype.method = ...`

## Module System

- **ESM only** (`"type": "module"` in `package.json`)
- Target: ES2023
- Module resolution: NodeNext
- All `.ts` imports resolve to `.js` in import specifiers

## CLI Progress/UI

- Use `src/cli/progress.ts` for progress indicators (wraps `osc-progress` + `@clack/prompts`)
- Use `src/terminal/table.ts` for table/status output
- Use the lobster palette from `src/terminal/palette.ts` for all color tokens

## Commits

- Use `scripts/committer "<msg>" <file...>` instead of manual `git add`/`git commit`
- Concise, action-oriented commit messages: `CLI: add verbose flag to send`
- Group related changes; avoid bundling unrelated refactors

---

*Convention analysis: 2026-03-08*
