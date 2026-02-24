# OpenClaw Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR: use heredocs (`-F - <<'EOF'`) for multiline strings; never embed `"\n"`.

## Project Structure

| Directory                                                     | Purpose                                             |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `src/`                                                        | Main source code (CLI, agents, gateway, channels)   |
| `src/cli/`                                                    | CLI commands and program setup                      |
| `src/agents/`                                                 | AI agent execution, tools, sessions                 |
| `src/gateway/`                                                | WebSocket/HTTP gateway server                       |
| `src/config/`                                                 | Configuration loading and types (modular)           |
| `src/plugin-sdk/`                                             | Plugin SDK for extensions                           |
| `src/{telegram,discord,slack,signal,whatsapp,imessage,line}/` | Messaging channel implementations                   |
| `extensions/`                                                 | Plugin extensions (workspace packages)              |
| `apps/`                                                       | Mobile/desktop companion apps (iOS, Android, macOS) |
| `packages/`                                                   | Workspace packages (clawdbot, moltbot)              |
| `test/`                                                       | Test setup files                                    |
| `dist/`                                                       | Build output                                        |

## Build, Test, and Development Commands

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Type check (faster than full build)
pnpm tsgo

# Lint and format check (run before commits)
pnpm check

# Auto-fix formatting issues
pnpm format:fix

# Run all unit tests
pnpm test

# Run fast unit tests only (excludes gateway, extensions)
pnpm test:fast

# Run single test file
pnpm test src/path/to/file.test.ts

# Run tests matching a pattern
pnpm test -- --grep "test pattern"

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage

# Run e2e tests
pnpm test:e2e

# Run CLI in dev mode
pnpm openclaw <command>

# Run gateway in dev mode
pnpm gateway:dev
```

## Code Style Guidelines

### TypeScript

- **Language**: TypeScript (ESM), strict mode enabled
- **Target**: ES2023, Node 20+
- **Module**: NodeNext with NodeNext resolution
- **Avoid**: `any`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`
- **Type imports**: Use `import type { X }` for type-only imports
- **No explicit any**: Never use `as any` or disable lint rules to suppress type errors

### Imports

```typescript
// Type imports (use for types only)
import type { Bot } from "grammy";
import type { GatewayServiceEnv } from "./service-types.js";

// Named imports with .js extension (required for ESM)
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
```

### Naming Conventions

| Type                | Convention           | Example                |
| ------------------- | -------------------- | ---------------------- |
| Product             | **OpenClaw**         | OpenClaw Gateway       |
| CLI/Package         | `openclaw`           | `openclaw gateway run` |
| Files               | kebab-case           | `agent-scope.ts`       |
| Classes             | PascalCase           | `GatewayServer`        |
| Functions/Variables | camelCase            | `resolveSessionKey`    |
| Constants           | SCREAMING_SNAKE_CASE | `GATEWAY_DEFAULT_PORT` |

### Error Handling

- Always handle errors explicitly; never use empty catch blocks
- Log errors with context using `runtime.error?.()` or `log.error()`
- For user-facing errors, provide actionable messages
- Use `String(err)` for safe error message extraction

```typescript
try {
  await someAsyncOperation();
} catch (err) {
  runtime.error?.(danger(`operation failed: ${String(err)}`));
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
- **Config**: `vitest.config.ts` (all), `vitest.unit.config.ts` (fast unit)
- **Coverage thresholds**: 70% lines/functions/statements, 55% branches
- **Test naming**: Match source files with `.test.ts` suffix
- **Test patterns**: `.test.ts` (unit), `.e2e.test.ts` (e2e), `.live.test.ts` (live API)
- **Max workers**: 16 (do not increase)

```typescript
// Use vi.hoisted for mock hoisting
const mockFn = vi.hoisted(() => vi.fn());

// Standard test structure
describe("MyClass", () => {
  it("should do something", () => {
    expect(true).toBe(true);
  });
});
```

## Commit Guidelines

- Use `scripts/committer "<msg>" <file...>` for scoped commits
- Action-oriented commit messages with scope:
  - `fix(telegram): send error notification on dispatch failure`
  - `feat(gateway): add WebSocket reconnection logic`
  - `refactor(agents): extract session management`
- Group related changes; avoid bundling unrelated refactors

## Important Constraints

1. **Never** commit or publish real phone numbers, API keys, or live config values
2. **Never** edit `node_modules` directly
3. **Never** add `@ts-nocheck` or disable `no-explicit-any`
4. **Never** use prototype mutation for sharing class behavior
5. **Always** run `pnpm check` before commits
6. **Always** consider all messaging channels when refactoring shared logic
7. **Always** use `.js` extension in imports for ESM compatibility

## Useful File Locations

| Purpose           | Path                                               |
| ----------------- | -------------------------------------------------- |
| CLI entry         | `src/index.ts`, `openclaw.mjs`                     |
| Config types      | `src/config/types.ts` (re-exports modular types)   |
| Gateway server    | `src/gateway/server.ts`                            |
| Telegram channel  | `src/telegram/`                                    |
| Agent runner      | `src/agents/pi-embedded-runner.ts`                 |
| Plugin SDK        | `src/plugin-sdk/index.ts`                          |
| Test setup        | `test/setup.ts`                                    |
| Vitest config     | `vitest.config.ts`, `vitest.unit.config.ts`        |
| LaunchAgent plist | `~/Library/LaunchAgents/ai.openclaw.gateway.plist` |
