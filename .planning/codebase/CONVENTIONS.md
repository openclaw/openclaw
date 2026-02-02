# Coding Conventions

**Analysis Date:** 2026-02-02

## Naming Patterns

**Files:**
- TypeScript source files use camelCase: `src/utils/boolean.ts`, `src/hooks/loader.ts`
- Test files are co-located with source files: `src/utils/boolean.test.ts`
- Extension files: `extensions/matrix/src/matrix/client.ts`

**Functions:**
- Exported functions use camelCase: `parseBooleanValue()`, `loadConfig()`
- Async functions consistently use `async` keyword
- Event handlers use descriptive names: `triggerInternalHook()`

**Variables:**
- Local variables use camelCase: `resolvedConfig`, `outboundDeps`
- Constants use UPPER_SNAKE_CASE for true constants: `DEFAULT_TRUTHY`, `DEFAULT_FALSY`
- Config objects use descriptive names: `OpenClawConfig`

**Types:**
- Interface names use PascalCase with Interface suffix: `BooleanParseOptions`, `OpenClawConfig`
- Type aliases use PascalCase: `ChannelId`, `RuntimeEnv`
- Generic type parameters use single letters: `T`, `K`, `V`

## Code Style

**Formatting:**
- Formatter: Oxfmt (not Prettier)
- Linter: Oxlint
- Run checks with: `pnpm check` (includes lint + format)

**Line Length:**
- Target: 100 characters (not strictly enforced but typical pattern)
- Long lines should be wrapped or split

**Indentation:**
- Spaces: 2 spaces (standard for modern TS)
- No tabs

**Braces:**
- Opening brace on same line: `{`
- Closing brace on new line

## Import Organization

**Order:**
1. Node.js imports (3rd party built-in)
2. External imports (3rd party npm packages)
3. Relative imports from same project

**Pattern:**
```typescript
// Node.js imports
import fs from "node:fs/promises";
import os from "node:os";

// External imports
import { defineConfig } from "vitest/config";
import type { OpenClawConfig } from "../src/config/config.js";

// Relative imports
import { parseBooleanValue } from "./boolean.js";
```

**Path Aliases:**
- No path aliases detected (uses relative imports)
- Import pattern: `import { thing } from "../module/thing.js"`

## Error Handling

**Patterns:**
- Try-catch blocks for async operations
- Error propagation with throw
- Optional error chaining

**Common Patterns:**
```typescript
// Basic try-catch
try {
  const result = await someAsyncOperation();
  return result;
} catch (error) {
  console.error("Operation failed:", error);
  throw error;
}

// Error handling with custom error
if (!config) {
  throw new Error("Configuration not found");
}

// Optional error propagation
const result = await riskyOperation().catch(error => {
  console.warn("Operation failed:", error);
  return null;
});
```

## Logging

**Framework:** Tslog (detected in dependencies)

**Patterns:**
- Use structured logging when available
- Error logging: `console.error()` for failures
- Debug logging for development flows

## Comments

**When to Comment:**
- Complex business logic
- Non-obvious dependencies
- Important edge cases
- TODO items with clear reasoning

**JSDoc/TSDoc:**
- Used on exported functions
- Used on complex type definitions
- Examples:
```typescript
/**
 * Parse a boolean value from various input types
 * @param value - Input to parse (boolean, string, etc.)
 * @param options - Custom truthy/falsy lists
 * @returns Parsed boolean or undefined if invalid
 */
export function parseBooleanValue(
  value: unknown,
  options: BooleanParseOptions = {}
): boolean | undefined {
  // Implementation
}
```

## Function Design

**Size:**
- Target: Under 500 LOC per file (guideline)
- Functions should be focused and single-purpose
- Large functions should be broken down

**Parameters:**
- Use object parameters for multiple related options
- Use interfaces for complex parameter types
- Default parameters should be at the end

**Return Values:**
- Use discriminated unions for success/failure
- Return null/undefined for optional results
- Use types like `Result<T>` for complex return patterns

## Module Design

**Exports:**
- Named exports over default exports
- Barrel files for related exports: `src/config/config.ts`
- Export type definitions separately when needed

**Barrel Files:**
- Used for logical grouping: `src/config/config.ts` re-exports from submodules
- Pattern: `export * from "./io.js"; export * from "./types.js";`

## Error Types and Validation

**Error Handling Strategy:**
- Validation using Zod schemas: `OpenClawSchema`
- Type-safe error handling with discriminated unions
- Error messages should be user-friendly

**Validation Patterns:**
```typescript
// Zod schema validation
const result = OpenClawSchema.safeParse(config);
if (!result.success) {
  throw new Error(`Invalid config: ${result.error.message}`);
}

// Type guards
if (typeof value !== "string") {
  return undefined;
}
```

## Testing Conventions

**Test File Structure:**
- Co-located with source files: `*.test.ts`
- Test naming matches source: `boolean.ts` → `boolean.test.ts`
- Test setup in `test/setup.ts`

**Test Patterns:**
- Use `describe()` for test suites
- Use `it()` for individual tests
- Use `expect()` for assertions
- Mock dependencies with `vi.mock()` and `vi.fn()`

**Async Testing:**
```typescript
it("async operation test", async () => {
  const result = await someAsyncOperation();
  expect(result).toBe("expected");
});
```

## Code Organization

**Directory Structure:**
```
src/
├── commands/      # CLI command implementations
├── config/        # Configuration management
├── utils/         # Shared utilities
├── agents/        # Agent-related code
├── hooks/         # Internal hooks system
└── test-utils/    # Testing utilities
```

**File Naming:**
- Descriptive names: `message-delivery.ts` not `msg.ts`
- Group related functionality: `*.commands.ts` for CLI commands
- Use consistent suffixes: `.test.ts` for tests

## Extension Development

**Extension Structure:**
- Extensions live in `extensions/*/`
- Each extension has its own `package.json`
- Extensions can have their own tests: `extensions/*/src/*.test.ts`

**Plugin Pattern:**
- Extensions follow plugin architecture
- Use shared types from `src/channels/plugins/types.js`
- Implement required interfaces for channel plugins

---

*Convention analysis: 2026-02-02*