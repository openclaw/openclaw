# OpenClaw Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR: use heredocs (`-F - <<'EOF'`) for multiline strings; never embed `"\n"`.

## Project Structure

- **Source**: `src/` (CLI in `src/cli`, commands in `src/commands`, infra in `src/infra`)
- **Tests**: Colocated `*.test.ts`; e2e tests in `*.e2e.test.ts`
- **Output**: `dist/`
- **Plugins**: `extensions/*` (workspace packages)
- **Messaging channels**: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web`, `src/channels`, `src/routing`

## Build, Test, and Development Commands

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Type check (faster than build)
pnpm tsgo

# Lint and format check
pnpm check

# Format fix
pnpm format:fix

# Run all tests
pnpm test

# Run single test file
pnpm test src/path/to/file.test.ts

# Run tests with coverage
pnpm test:coverage

# Run tests in watch mode
pnpm test:watch

# Run fast unit tests only
pnpm test:fast

# Run e2e tests
pnpm test:e2e

# Run CLI in dev mode
pnpm openclaw <command>
```

## Code Style Guidelines

### TypeScript

- **Language**: TypeScript (ESM), strict mode enabled
- **Target**: ES2023, Node 22+
- **Module**: NodeNext with NodeNext resolution
- **Avoid**: `any`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`
- **Type imports**: Use `import type { X }` for type-only imports

### Imports

```typescript
// Type imports
import type { Bot } from "grammy";

// Named imports with .js extension (required for ESM)
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
```

### Naming Conventions

- **Product**: Use **OpenClaw** for headings and documentation
- **CLI/Package**: Use `openclaw` for commands, package names, paths, config keys
- **Files**: kebab-case for filenames, matching class/function names with `.ts` extension
- **Classes**: PascalCase
- **Functions/Variables**: camelCase
- **Constants**: SCREAMING_SNAKE_CASE for true constants

### Error Handling

- Always handle errors explicitly; never use empty catch blocks
- Log errors with context using `runtime.error?.()` or `log.error()`
- For user-facing errors, provide actionable messages
- Example pattern:

```typescript
try {
  await someAsyncOperation();
} catch (err) {
  runtime.error?.(danger(`operation failed: ${String(err)}`));
  // Optionally notify user or re-throw
  throw err;
}
```

### Formatting

- Formatting via **Oxfmt**, linting via **Oxlint**
- Run `pnpm check` before commits
- Run `pnpm format:fix` to auto-fix formatting issues
- Keep files under ~700 LOC; split when it improves clarity
- Add brief comments for tricky or non-obvious logic

### Class Design

- Use explicit inheritance (`A extends B`) or composition
- **Never** share behavior via prototype mutation (`applyPrototypeMixins`, `Object.defineProperty` on `.prototype`)
- In tests, prefer per-instance stubs over prototype mutation

## Testing Guidelines

- **Framework**: Vitest with V8 coverage
- **Coverage thresholds**: 70% lines/branches/functions/statements
- **Test naming**: Match source files with `.test.ts` suffix
- **Max workers**: 16 (do not increase)
- **Test patterns**:

```typescript
// Use vi.hoisted for mock hoisting
const mockFn = vi.hoisted(() => vi.fn());

// Use describe/it blocks
describe("MyClass", () => {
  it("should do something", () => {
    expect(true).toBe(true);
  });
});
```

## Commit Guidelines

- Use `scripts/committer "<msg>" <file...>` for scoped commits
- Action-oriented commit messages: `fix(telegram): send error notification on dispatch failure`
- Group related changes; avoid bundling unrelated refactors

## Important Constraints

1. **Never** commit or publish real phone numbers, API keys, or live config values
2. **Never** edit `node_modules` directly
3. **Never** add `@ts-nocheck` or disable `no-explicit-any`
4. **Never** use prototype mutation for sharing class behavior
5. **Always** run `pnpm check` before commits
6. **Always** consider all messaging channels when refactoring shared logic

## Useful File Locations

| Purpose          | Path                                        |
| ---------------- | ------------------------------------------- |
| CLI entry        | `src/index.ts`, `openclaw.mjs`              |
| Config types     | `src/config/types.ts`                       |
| Gateway server   | `src/gateway/`                              |
| Telegram channel | `src/telegram/`                             |
| Agent runner     | `src/agents/pi-embedded-runner/`            |
| Plugin SDK       | `src/plugin-sdk/`                           |
| Test setup       | `test/setup.ts`                             |
| Vitest config    | `vitest.config.ts`, `vitest.unit.config.ts` |
