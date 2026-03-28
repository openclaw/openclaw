# Coding Conventions

**Analysis Date:** 2026-03-26

## Naming Patterns

**Files:**

- Lowercase with hyphens for multi-word names
- Test files: `*.test.ts` (colocated with source)
- Utilities grouped in `shared/` directory, organized by feature (e.g., `shared/text/`, `shared/net/`)
- Helper modules may use descriptive prefixes: `pid-alive.ts`, `device-auth.ts`

**Functions:**

- camelCase for function names
- Descriptive verb-based names: `parseApiErrorPayload()`, `extractLeadingHttpStatus()`, `summarizeStringEntries()`
- Predicates prefixed with `is` or `has`: `isErrorPayloadObject()`, `hasOwn()`
- Lazy loaders prefixed with `create`: `createLazyRuntimeModule()`, `createLazyRuntimeMethod()`

**Variables:**

- camelCase for local variables and parameters
- SCREAMING_SNAKE_CASE for constants: `ERROR_PAYLOAD_PREFIX_RE`, `BLOCKED_IPV4_SPECIAL_USE_RANGES`, `TEST_PROCESS_MAX_LISTENERS`
- `Type` prefix for type aliases used as discriminators
- Descriptive names over abbreviated: `embeddedIpv4` not `eip4`

**Types:**

- PascalCase for interfaces and type aliases
- Prefix `Params` for function parameter objects: `Ipv4SpecialUseBlockOptions`
- Suffix `Result` or `Response` for return types
- API result types named `*Info`: `ApiErrorInfo`
- Use generics liberally with `T` prefix: `TModule`, `TSurface`, `TKey`

## Code Style

**Formatting:**

- Tool: Oxfmt (Rust-based formatter, part of Oxlint suite)
- Run via `pnpm format:fix` (applies changes) or `pnpm format:check` (checks only)
- Configuration: `.oxlintrc.json` (linting rules; oxfmt has no separate config file)
- Line width: Follows Oxfmt defaults (typically 100 characters)
- Indentation: 2 spaces (enforced by oxfmt)

**Linting:**

- Tool: Oxlint (Rust implementation of ESLint rules)
- Configuration file: `.oxlintrc.json`
- Key rules enforced:
  - `typescript/no-explicit-any`: ERROR (strict typing required; no `any` escapes)
  - `curly`: ERROR (all blocks must have braces)
  - `correctness`, `perf`, `suspicious`: all set to ERROR
  - Several rules disabled for practicality: `no-await-in-loop`, `no-shadow`, `no-new`
- Run via: `pnpm lint` (CI uses this as a gate)

**Strict TypeScript:**

- `strict: true` in `tsconfig.json`
- `noEmit: true`, `noEmitOnError: true` (type errors block build)
- Target: ES2023, Module: NodeNext (ESM only)
- Never use `@ts-nocheck` or disable `no-explicit-any` — fix root causes instead

## Import Organization

**Order:**

1. Node.js builtins: `import process from "node:process"`
2. External packages: `import ipaddr from "ipaddr.js"`
3. Internal absolute paths (via tsconfig aliases): `import { getChannelPlugin } from "openclaw/plugin-sdk"`
4. Internal relative paths: `import { createStubPlugin } from "../test-utils/channel-plugins.js"`

**Path Aliases:**

- `openclaw/extension-api` → `./src/extensionAPI.ts`
- `openclaw/plugin-sdk` → `./src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/*` → `./src/plugin-sdk/*.ts` (subpaths)
- Used throughout to avoid relative imports (`../../../`)

**Barrel Files:**

- Index files (`index.ts`) in modules export public API
- Examples: `src/index.ts`, `src/plugin-sdk/index.ts`, `src/channels/plugins/index.ts`
- Comments indicate what's intentionally kept small or lazy

## Error Handling

**Patterns:**

- Throw descriptive `Error` instances with context: `throw new Error("node required")`
- Include known/available information in error messages: `throw new Error(\`unknown node: ${q}${known ? \` (known: ${known})\` : ""}\`)`
- Silent `catch` blocks when error is expected: `catch { /* ignore parse errors */ }`
- Use type predicates to validate error payloads before processing: `isErrorPayloadObject()` guards JSON parse attempts
- API error parsing tolerates malformed input gracefully, returns `null` rather than throwing
- Guard clauses for validation: `if (!trimmed) return false;` early in functions

## Logging

**Framework:** Built-in `console` API

**Patterns:**

- Minimal inline logging; most logging happens at integration layer
- Test setup uses process environment to configure listeners: `process.env.VITEST = "true"`
- Advanced logging facilities behind lazy-loaded boundaries (e.g., runtime modules)
- No centralized logging abstraction visible in core conventions

## Comments

**When to Comment:**

- Explain non-obvious regex patterns: `// IPv4-compatible form ::w.x.y.z (deprecated...)`
- Document special-case handling in conditionals
- Include references to RFCs or standards when relevant: `// NAT64 local-use prefix: 64:ff9b:1::/48`
- Avoid restating what code does; explain why

**JSDoc/TSDoc:**

- Used sparingly; primary docs via function signatures and type annotations
- Brief one-line comments for exported utilities: `/** Cache the raw dynamically imported runtime module behind a stable loader. */`
- No `@param` or `@returns` tags observed; types already in signature

## Function Design

**Size:** Aim to keep functions under ~50 lines when feasible. Examples in codebase:

- `summarizeStringEntries()`: 14 lines
- `parseApiErrorPayload()`: 26 lines
- `createLazyRuntimeSurface()`: 10 lines

**Parameters:**

- Use object parameters for functions with multiple arguments: `summarizeStringEntries(params: { entries?: ...; limit?: ...; emptyText?: ... })`
- Destructure in parameter list when appropriate
- Provide sensible defaults: `params.limit ?? 6`, `params.emptyText ?? ""`

**Return Values:**

- Return `null` for missing/invalid results (not `undefined` when null is semantically correct)
- Use unions for fallback branches: `code: number; rest: string } | null`
- Single-line returns when logic is clear; multi-line conditional returns otherwise

## Module Design

**Exports:**

- Named exports by default; default export only for entry points or when it's the single public API
- Separate type exports: `export type ApiErrorInfo = { ... }`
- Keep re-exports clean in barrel files: use type-only imports for type re-exports

**Barrel Files:**

- Minimal top-level re-exports (prefer lazy subpaths)
- Example from `src/plugin-sdk/index.ts`: re-exports only widely-used types, leaves detailed APIs on subpaths
- Use comments to explain intent: `// Shared root plugin-sdk surface. Keep this entry intentionally tiny.`

---

_Convention analysis: 2026-03-26_
