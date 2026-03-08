# Coding Conventions

**Analysis Date:** 2026-03-08

## Naming Patterns

**Files:**
- Use kebab-case for file names: `agent-scope.ts`, `error-text.ts`, `acp-spawn-parent-stream.ts`
- Test files use `.test.ts` suffix: `agent-scope.test.ts`
- Feature-specific files use dot notation for type indication: `manager.core.ts`, `manager.types.ts`, `payloads.errors.test.ts`
- Domain grouping: Related files organized in directories (e.g., `/acp/control-plane/`, `/agents/`, `/commands/`)

**Functions:**
- Use camelCase for function names: `resolveAgentConfig()`, `listAgentIds()`, `stripNullBytes()`
- Prefix utility functions with verb indicating action: `resolve*`, `list*`, `ensure*`, `normalize*`, `parse*`, `create*`, `with*`
- Example patterns from `src/agents/agent-scope.ts`:
  - `resolveSessionAgentIds()` - returns computed/resolved values
  - `ensureOpenClawAgentEnv()` - performs side effects and ensures state
  - `listAgentIds()` - returns collections

**Variables:**
- Use camelCase for local variables and parameters
- Use SCREAMING_SNAKE_CASE for constants: `DEFAULT_AGENT_ID`, `ENTRY_WRAPPER_PAIRS`, `EXPERIMENTAL_WARNING_FLAG`
- Prefix boolean variables with verb when appropriate: `hasExperimentalWarningSuppressed()`, `shouldForceReadOnlyAuthStore()`
- Singular names for single values, plural for collections: `agent`, `agents`; `id`, `ids`

**Types:**
- Use PascalCase for type/interface names: `ResolvedAgentConfig`, `AgentEntry`, `OpenClawConfig`
- Use generic parameter naming: `T` for single type, `K` for keys, `V` for values
- Type definitions found in files like `src/agents/agent-scope.ts:25-41`

**Enums and Constants:**
- Example from `src/entry.ts:15-18`:
```typescript
const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;
```

## Code Style

**Formatting:**
- Tool: `oxfmt` (Rust-based formatter, configured in `.oxfmtrc.jsonc`)
- Run: `pnpm format` and `pnpm format:check`
- Style enforced via CI: `pnpm check` includes format checks

**Linting:**
- Tool: `oxlint` (type-aware linting) configured in `.oxlintrc.json`
- Run: `pnpm lint` (with type checking), `pnpm lint:fix`
- Also uses TypeScript strict mode: see `tsconfig.json` with `"strict": true`
- ESLint rules disabled in favor of oxlint (seen in comments: `// eslint-disable-next-line`)

**Line Length:**
- Performance budget enforced: `pnpm check:loc --max 500` (max 500 lines per file)

**Indentation:**
- 2 spaces (typical for TypeScript/Node.js projects)

## Import Organization

**Order:**
1. Node.js built-in modules: `import fs from "node:fs/promises"`; `import path from "node:path"`
2. External packages: `import { describe, expect, it } from "vitest"`
3. Internal modules: `import { resolveStateDir } from "../config/paths.js"`
4. Same module exports: `export { resolveAgentIdFromSessionKey }`

**Path Aliases:**
- Plugin SDK subpaths defined in `tsconfig.json`: `openclaw/plugin-sdk/*`
- Example: `import "openclaw/plugin-sdk/telegram"`

**File Extensions:**
- Always use `.js` extensions in imports for ES modules: `from "./version.js"`
- This matches the `"type": "module"` in `package.json`

**Re-exports (Barrel Files):**
- Export re-exported items with explicit `export { name }` syntax
- Found in `src/agents/agent-scope.ts:23`: `export { resolveAgentIdFromSessionKey }`

## Error Handling

**Patterns:**
- Use typed error classes: `AcpRuntimeError` wraps errors with code and message
- Example from `src/acp/runtime/errors.test.ts`:
```typescript
await expect(
  withAcpRuntimeErrorBoundary({
    run: async () => {
      throw new Error("boom");
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "fallback",
  }),
).rejects.toMatchObject({
  name: "AcpRuntimeError",
  code: "ACP_TURN_FAILED",
  message: "boom",
});
```

- Use `withAcpRuntimeErrorBoundary()` wrapper to convert errors: catches unknown errors and re-wraps them
- Pass through existing domain errors without modification
- Generic error messages for logging: `error instanceof Error ? error.message : String(error)`

**Try-Catch Usage:**
- Catch and convert to typed errors in async functions
- Silent catches with `.catch(() => {})` when side effects are best-effort (e.g., logging failures)

## Logging

**Framework:** `tslog` (from `package.json` dependencies)

**Logger Creation:**
- Use `createSubsystemLogger()` to create domain-specific loggers: `const log = createSubsystemLogger("agent-scope")`
- Found in `src/agents/agent-scope.ts:15`

**Methods:**
- `log.warn()` - for warnings (used in agent validation)
- Logs scoped to subsystems for better debugging

## Comments

**When to Comment:**
- Document non-obvious logic or constraints: "Guard: only run entry-point logic when this file is the main module" (line 30, `src/entry.ts`)
- Explain why a design choice exists, not what the code does
- Disable linter rules when necessary with rationale: `// eslint-disable-next-line no-control-regex` (stripping null bytes reason)

**JSDoc/TSDoc:**
- Type definitions sometimes include doc strings
- Not consistently used for all functions; focus on complex ones

**Inline Comments:**
- Use for control flow guards and important state mutations
- Example: `// Respawn guard (and keep recursion bounded if something goes wrong).`

## Function Design

**Size:**
- Prefer small functions (<50 lines)
- Example: `stripNullBytes()` (2 lines), `resolveAgentConfig()` (27 lines)
- Large entry point functions are broken into focused helpers

**Parameters:**
- Use object parameters for functions with multiple related options
- Example from `src/agents/agent-scope.ts:85-102`:
```typescript
export function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  // ...
}
```
- Rationale: Extensible without breaking changes, clear naming at call sites

**Return Values:**
- Undefined for "not found" cases (nullable results)
- Objects with multiple computed values when needed
- Array of T for collections
- Boolean for predicates: `hasConfiguredModelFallbacks()`, `shouldForceReadOnlyAuthStore()`

## Module Design

**Exports:**
- Named exports exclusively (no default exports) - matches `CLAUDE.md` rule
- Export types separately from implementations: `export type ResolvedAgentConfig = { ... }`
- Found throughout: `export function`, `export type`, `export { ResolvedAgentId FromSessionKey }`

**Module Organization:**
- Group related functions in single file by domain
- Separate config resolution from config types
- Example: `agent-scope.ts` contains all agent resolution logic; `agent-paths.ts` contains filesystem path logic

## Environment & Configuration

**Env Var Naming:**
- Use SCREAMING_SNAKE_CASE: `OPENCLAW_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `OPENCLAW_STATE_DIR`
- Prefix with product name: `OPENCLAW_*`, `CLAWDBOT_*`
- Boolean env vars checked with `isTruthyEnvValue()` utility

**Configuration Access:**
- Load config at startup in `src/config/`
- Pass config objects through function parameters rather than global singletons
- Resolve env vars in one place; thread through call stack

## Type Safety

**TypeScript Strict Mode:**
- Enabled: `"strict": true` in `tsconfig.json`
- All implicit `any` types must be explicitly annotated
- Null/undefined checks required before property access
- Use type guards: `typeof === "string"`, `Array.isArray()`, `entry is AgentEntry`

**Example from `src/agents/agent-scope.ts:50`:**
```typescript
return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
```

## FrankOS Governance Standards (When Applicable to Code)

**Documentation = Reality:**
- Code comments and commit messages must accurately reflect actual behavior
- If documentation says "optimized" but code is inefficient, fix the code or update docs to match reality
- Source: `10_Constitution/Engineering-Constitution.md`

**Testing Before Deployment:**
- No configuration changes deployed without verification testing
- Rollback plans documented before changes
- Risk assessment logged in ledger

---

*Convention analysis: 2026-03-08*
