# Coding Conventions

**Analysis Date:** 2026-03-17

## Naming Patterns

**Files:**

- Kebab-case for all file names: `pairing-challenge.ts`, `channel-plugins.ts`, `infra-store.test.ts`
- Test files: `*.test.ts` for unit tests, `*.e2e.test.ts` for end-to-end tests
- Live/integration tests: `*.live.test.ts` for tests requiring real credentials/external services
- Type files use `.ts` extension (no `.d.ts` unless auto-generated)

**Functions:**

- camelCase for all function names: `issuePairingChallenge()`, `ensureDir()`, `buildPairingReply()`
- Async functions return `Promise<T>`: e.g., `async function readSessionStoreJson5(): Promise<Result<Store>>`
- Factory functions prefixed with `create`: `createTestRegistry()`, `createStubPlugin()`, `createDefaultRegistry()`
- Predicate functions prefixed with `is` or `should`: `isSelfChatMode()`, `isRecord()`, `assertWebChannel()`
- Helper utilities use descriptive verbs: `normalizeE164()`, `toWhatsappJid()`, `shortenHomePath()`

**Variables:**

- camelCase for all variables and constants: `tempHome`, `testEnv`, `entryPoints`
- Enum-like constants (readonly records) in camelCase: not UPPER_CASE
- Callback parameters are explicit in types, not inferred

**Types:**

- PascalCase for types: `PairingChallengeParams`, `ChannelPlugin`, `ChannelId`
- Use generic suffixes: `Adapter`, `Config`, `Context`, `Result`, `State`
- Discriminated unions with explicit `role` or `type` fields: see `buildAgentMessageFromConversationEntries()` pattern
- Type re-exports via barrel files are aggregated (`.ts/types.ts` patterns)

## Code Style

**Formatting:**

- Tool: Oxfmt (via `pnpm format` and `pnpm format:fix`)
- Config: `.oxlintrc.json` (not `.prettierrc`, which exists for docs only)
- All TypeScript code formatted via Oxfmt; pre-commit hooks enforce this
- Run `pnpm check` before commits to catch formatting issues

**Linting:**

- Tool: Oxlint (`oxlint --type-aware`)
- Config: `.oxlintrc.json`
- Plugins: `unicorn`, `typescript`, `oxc`
- Key rules:
  - `typescript/no-explicit-any`: error (no `any` types allowed)
  - `typescript/no-extraneous-class`: off (allowed where needed)
  - `typescript/no-unsafe-type-assertion`: off (type assertions permitted)
  - `unicorn/consistent-function-scoping`: off (functions can be declared at module or function level)
  - `curly`: error (braces required for all control structures)
- Run `pnpm lint` to check; `pnpm lint:fix` to auto-fix
- Custom lint checks: `pnpm lint:plugins:*`, `pnpm lint:auth:*`, `pnpm lint:tmp:*`

## Import Organization

**Order:**

1. Node.js standard library imports (`import fs from "node:fs"`)
2. Third-party packages (`import { describe, expect, it } from "vitest"`)
3. Local module imports (`import { issuePairingChallenge } from "./pairing-challenge.js"`)
4. Sibling and parent imports sorted alphabetically by relative path
5. Type-only imports grouped and sorted alphabetically

**Path Aliases:**

- `openclaw/plugin-sdk`: mapped to `src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/<subpath>`: mapped to `src/plugin-sdk/<subpath>.ts` (via vitest alias config)
- No barrel file re-exports for plugin-sdk; direct subpath imports only
- Relative imports used within same package; absolute aliases used for cross-package references

**Example:**

```typescript
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelId } from "./types.js";
import { ensureDir, normalizeE164 } from "./utils.js";
```

## Error Handling

**Patterns:**

- Use `try/catch (err)` with unknown type and narrow with type guard or assertion: `(err as { code?: string }).code`
- For expected errors (file not found), check error code after narrowing: `if (code !== "ENOENT") throw`
- For optional operations, use `.catch(() => {})` inline: `await fs.unlink(path).catch(() => {})`
- Throw descriptive Error messages with context: `throw new Error("invalid pairing channel")`
- No error classes; use Error with message strings
- Callbacks accept error parameter without throwing immediately: `onReplyError?.(err)` (caller decides handling)
- Never log sensitive data (API keys, tokens, passwords)

## Logging

**Framework:** `tslog` (imported as `logger` from `src/globals.js`)

**Patterns:**

- Use `logVerbose()` for debug output (guarded by `shouldLogVerbose()`)
- Use `logger.info/warn/error()` for structured logging
- Use `console.log()` only for CLI output (interactive flows)
- All gateway/background operations use `logger`
- Verbose output guarded by environment: `if (shouldLogVerbose()) logVerbose(...)`

## Comments

**When to Comment:**

- Complex business logic that isn't obvious from variable/function names
- Non-obvious algorithm choices or workarounds (with issue links where applicable)
- Design decisions that differ from expected patterns
- Tricky type casts or conditionals

**JSDoc/TSDoc:**

- Use JSDoc comments for exported functions and types
- Document parameters with `@param`, return type with `@returns`
- Document deprecation with `@deprecated` followed by migration path
- Example: see `src/agents/command-poll-backoff.ts` and `src/agents/openai-ws-stream.ts`
- Include `@see` links to related code or issues: `@see https://...`

**Example JSDoc:**

```typescript
/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 *
 * @param params Configuration for pairing challenge issuance
 * @returns Result object with created flag and optional code
 * @deprecated Legacy bridge for older flows. See pairing-v2.ts for new implementation.
 */
export async function issuePairingChallenge(
  params: PairingChallengeParams,
): Promise<{ created: boolean; code?: string }> {
  // ...
}
```

## Function Design

**Size:** Keep functions under ~200 lines; split larger functions into helpers

- Large files (>500 LOC) should be broken into modules
- Extract common logic into helper functions rather than duplicating

**Parameters:**

- Prefer parameter objects (destructured) over multiple positional params
- Use type-safe parameter objects: `params: { foo: string; bar?: number }`
- No variadic parameters; use arrays explicitly: `items: T[]` instead of `...items: T[]`

**Return Values:**

- Use Result/Option types for potentially-failing operations: `{ ok: boolean; value?: T; error?: string }`
- Use discriminated unions for multi-outcome returns: `{ created: true; code: string } | { created: false }`
- Never return `null`; use `undefined` or explicit optional types
- Async functions always return `Promise<T>` (never a union with non-Promise)

## Module Design

**Exports:**

- Default export only for entry points; use named exports elsewhere
- Export types separately from values: `export type SomeType = ...` and `export function someFn() {}`
- Group related exports together in source file
- Use `export { Type1, Type2 } from "./types.js"` for re-exports

**Barrel Files:**

- Minimal barrel files; prefer direct imports
- Plugin SDK has special barrel handling via `sync-plugin-sdk-exports.mjs` (auto-generated)
- Don't manually maintain barrel files for plugin-sdk; rely on generation script

**Module Boundaries:**

- No prototype mutation or dynamic patching: use explicit inheritance/composition
- Each module has a single responsibility
- Avoid circular imports; use dependency injection or deferred imports if needed
- Use `import type { ... } from "..."` for type-only imports to avoid circular deps

## TypeScript Specifics

- Strict mode enabled (no implicit `any`)
- Use `unknown` for untyped error catches, then narrow with type guards
- Avoid `as` casts; use type guards or constructors instead
- Generic functions should have constrained type parameters
- No `@ts-nocheck` or disabling of linting rules; fix root cause instead

## Testing Patterns in Source

- Test files co-located with source: `src/pairing/pairing-challenge.ts` + `src/pairing/pairing-challenge.test.ts`
- Use vitest's `describe()` and `it()` structure
- Mock calls: `vi.fn()`, `vi.spyOn()`, `vi.mock()`
- Environment stubbing: `vi.stubEnv()` for per-test isolation
- Faker/fixture data: use `captureEnv()`, `withEnvAsync()`, `withTempDir()` helpers

---

_Convention analysis: 2026-03-17_
