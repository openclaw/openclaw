# Coding Conventions

**Analysis Date:** 2026-02-15

## Naming Patterns

**Files:**
- Lowercase with hyphens: `session.ts`, `auto-reply.ts`, `send-api.ts`
- Utility files: `util.ts`, `constants.ts`, `helpers.ts`
- Test files: `{feature}.test.ts` (co-located with source), `{feature}.e2e.test.ts`, `{feature}.live.test.ts`
- Test harness/fixture files: `{feature}.test-harness.ts` (in source directory, not excluded from code)

**Functions:**
- Camel case: `enqueueSaveCreds()`, `createWaSocket()`, `fetchLatestBaileysVersion()`
- Async functions: `async function safeSaveCreds()`, `async createChannelHandler()`
- Internal/private functions: no underscore prefix, scope via module closure
- Factory functions: `create*` prefix (e.g., `createChannelHandler`, `createStubPlugin`)
- Query/getter functions: `is*`, `get*`, `resolve*` prefixes (e.g., `getStatusCode()`, `resolveChunkMode()`)
- Utility functions: descriptive verbs (e.g., `normalizeReplyPayloadsForDelivery`, `appendAssistantMessageToSessionTranscript`)

**Variables:**
- Camel case: `credsPath`, `authDir`, `sessionLogger`, `replyLogger`
- Constants: UPPERCASE for module-level constants (e.g., `TEST_PROCESS_MAX_LISTENERS`)
- Prefixes for clarity: `base*`, `is*`, `maybe*`, `default*` (e.g., `baseName`, `maybeRestoreCredsFromBackup`, `defaultWorkers`)

**Types:**
- `type` keyword for type aliases (not interfaces): `export type WebInboundMessage = { ... }`
- PascalCase names: `WebInboundMessage`, `OutboundSendDeps`, `OutboundDeliveryResult`
- Generic type parameters: `T`, `Deps`, etc.
- Type imports: `import type { SomeType } from "./file.js"`

## Code Style

**Formatting:**
- Tool: `oxfmt` (Oxidize formatter) - enforces consistent style automatically
- Configuration: `.oxfmtrc.jsonc`
- Key settings:
  - Import sorting enabled with `experimentalSortImports`
  - Package.json script sorting enabled with `experimentalSortPackageJson`
  - No custom newlines between import groups (consolidated)
- Run: `pnpm format` to auto-format, `pnpm format:check` to verify

**Linting:**
- Tool: `oxlint` with TypeScript plugin and Unicorn plugin
- Configuration: `.oxlintrc.json`
- All error categories enforced: `correctness`, `perf`, `suspicious`
- Key rules:
  - `typescript/no-explicit-any`: error (strict typing required)
  - `curly`: error (all blocks must have braces)
  - Some rules disabled for pragmatism: `typescript/no-unsafe-type-assertion`, `unicorn/consistent-function-scoping`
- Run: `pnpm lint` to check, `pnpm lint:fix` to auto-fix

**TypeScript:**
- Target: ES2023
- Module: NodeNext with declaration files
- Strict mode enabled: `noEmit`, `noEmitOnError`, `strict: true`
- Type checking: `forceConsistentCasingInFileNames`, `skipLibCheck`, `allowImportingTsExtensions`

## Import Organization

**Order:**
1. Node.js built-in imports (e.g., `import fs from "node:fs"`)
2. Third-party dependencies (e.g., `import { z } from "zod"`)
3. Type imports from external packages (e.g., `import type { SomeType } from "@package/name"`)
4. Relative imports from project (e.g., `import { loadConfig } from "../../config/config.js"`)
5. Type imports from project (e.g., `import type { OpenClawConfig } from "../../config/config.js"`)
6. Re-exports (e.g., `export { createStubPlugin } from "./plugin.js"`)

**Path Aliases:**
- `openclaw/plugin-sdk`: resolves to `./src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/account-id`: resolves to `./src/plugin-sdk/account-id.ts`
- Full relative paths used in non-aliased imports (e.g., `../../config/config.js`)
- Always include `.js` extension in relative imports (ESM standard)

**Export Style:**
- Named exports preferred: `export const functionName = () => {}`
- Type re-exports: `export type { SomeType } from "./file.js"`
- Barrel files permitted: index.ts files that re-export from submodules

## Error Handling

**Patterns:**
- Try-catch with specific fallback behavior: attempt operation, catch with purpose
- Best-effort operations don't throw: wrap in try-catch with comment explaining fallback
- Example (from `src/web/session.ts`):
  ```typescript
  try {
    // Best-effort backup so we can recover after abrupt restarts
    fsSync.copyFileSync(credsPath, backupPath);
    fsSync.chmodSync(backupPath, 0o600);
  } catch {
    // keep existing backup
  }
  ```
- Logger integration: catch blocks use logger.warn/error instead of silent swallowing
- Validation errors use structured approach via Zod schemas (`src/config/zod-schema.ts`)

**Error Objects:**
- Use standard `Error` class with descriptive messages: `throw new Error("Outbound not configured for channel: ${channel}")`
- Extract error details for logging: `{ error: String(err) }` or structured properties like `statusCode`, `output.payload`
- Use instanceof checks for error type guards: `if (err instanceof Error)`

## Logging

**Framework:** tslog (custom loggers via `getChildLogger()`)

**Patterns:**
- Create module-specific loggers: `const sessionLogger = getChildLogger({ module: "web-session" })`
- Use logger levels: `.info()`, `.warn()`, `.error()`, `.debug()`
- Structured logging: pass object as first argument with metadata
- Example: `logger.warn({ error: String(err) }, "WhatsApp creds save queue error")`
- Verbose logging: check `shouldLogVerbose()` guard before expensive operations
- Message context: always describe what failed and why

## Comments

**When to Comment:**
- Complex algorithms or business logic
- Non-obvious error recovery strategies
- Important constraints or assumptions
- Workarounds for third-party library issues
- Intentional deviations from patterns (marked with `// oxlint-disable-next-line rule-name`)

**Comment Style:**
- Single-line: `// explanation`
- Multi-line: `/* multi-line explanation */`
- Inline clarifications: place after code on same line when brief
- Do NOT document obvious code (e.g., don't comment variable assignments)

**Linting Directives:**
- Disable specific rules with inline comments when necessary: `// oxlint-disable-next-line typescript/no-explicit-any`
- Comment placement: immediately before the problematic line
- Reason not required in source (captured in commit history)

## Function Design

**Size:**
- Maximum: 500 lines of TypeScript per file (enforced via `pnpm check:loc`)
- Target: small focused functions (typical 20-80 lines)
- Split logic into helper functions when approaching limit

**Parameters:**
- Prefer object parameter destructuring for >2 parameters
- Example: `async function createChannelHandler(params: { cfg: Config; channel: Channel; ... })`
- Type parameters in destructured objects for clarity
- Optional params marked with `?`: `param?: type`

**Return Values:**
- Always explicitly type return values (no implicit `any`)
- Async functions return `Promise<T>`
- Use discriminated unions for success/error alternatives when appropriate
- Nullable returns use optional: `returns: SomeType | undefined`

## Module Design

**Exports:**
- Export clear public API at module level
- Internal helpers stay private (no export)
- Type exports separate from value exports: `export type { Type } from "./file.js"`
- Barrel exports common in `index.ts` files

**Module Patterns:**
- Single responsibility: each file has one clear purpose
- Dependencies injected via parameters (not global singletons where possible)
- Plugin system uses dynamic loading: `await loadChannelOutboundAdapter(channelId)`
- Test utilities in separate files: `test-utils/`, `test-helpers.ts`

**Circular Dependencies:**
- Avoided through careful import ordering
- Use `type` imports to break cycles: `import type { Type } from "./file.js"`

---

*Convention analysis: 2026-02-15*
