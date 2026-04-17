# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For full architecture boundaries, boundary rules, and detailed workflows, see `AGENTS.md`.** Scoped guides exist at `extensions/AGENTS.md`, `src/plugin-sdk/AGENTS.md`, `src/channels/AGENTS.md`, `src/plugins/AGENTS.md`, `src/gateway/protocol/AGENTS.md`, `test/helpers/AGENTS.md`.

## Project Summary

OpenClaw is a personal AI assistant platform that runs locally on user devices. It connects to 20+ messaging channels (WhatsApp, Telegram, Slack, Discord, iMessage, etc.) through a gateway architecture with an extensible plugin system.

## Tech Stack

- **Language**: TypeScript (ESM, strict mode)
- **Runtime**: Node 22+ (Bun supported for dev/scripts)
- **Package Manager**: pnpm (`pnpm install`, keep `pnpm-lock.yaml` in sync)
- **Build**: tsdown → `dist/`
- **Lint/Format**: Oxlint + Oxfmt
- **Tests**: Vitest with V8 coverage
- **CLI Framework**: Commander + clack/prompts

## Commands

```bash
pnpm install            # Install dependencies
pnpm build              # Build all sources
pnpm check              # Lint + format + type-check + import-cycle checks (main dev gate)
pnpm tsgo               # TypeScript type-check only
pnpm format             # Format with oxfmt (--write)
pnpm format:check       # Format check only
pnpm test               # Run test suite (vitest)
pnpm test:coverage      # Run tests with coverage
pnpm test <path>        # Run a specific test file
pnpm openclaw ...       # Run CLI in dev mode
pnpm dev                # Development mode
```

### Single test

```bash
pnpm test src/commands/onboard-search.test.ts
pnpm test src/commands/onboard-search.test.ts -t "shows registered plugin providers"  # filtered
```

### Pre-commit

Pre-commit hook runs `pnpm format` then `pnpm check`. Use `FAST_COMMIT=1` to skip these for fast commit loops (only when you've manually verified the touched surface).

## Architecture Overview

```
src/
├── agents/         # Agent system, ACP integration, model catalogs
├── channels/       # Core channel implementations (Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Web)
├── cli/            # CLI wiring, progress spinners, prompts
├── commands/       # CLI command handlers
├── config/         # Configuration management, schema, migrations
├── extensions/     # Extensible components (70+ extensions)
├── gateway/        # HTTP/WebSocket gateway server, sessions, auth
├── infra/          # Shared utilities (formatting, time, etc.)
├── plugins/        # Plugin discovery, manifest validation, loader, registry
├── plugin-sdk/     # Public plugin SDK (the only cross-package contract for extensions)
├── process/        # Process management
├── terminal/       # Terminal output (tables, themes, colors)
│
extensions/         # Bundled workspace plugins (channels, providers, tools)
apps/               # Mobile/desktop apps (Android/Kotlin, iOS/Swift, macOS/Swift)
test/               # Test infrastructure and shared helpers
scripts/            # Build scripts, codegen, CI tooling
ui/                 # Web UI (Lit-based control panel)
docs/               # Documentation site (Mintlify)
```

### Key Architectural Boundaries

- **Plugin SDK** (`src/plugin-sdk/*`) is the only public cross-package contract. Extensions must import from `openclaw/plugin-sdk/*`, never from `src/**` directly.
- **Core** (`src/`) must stay extension-agnostic. Adding a bundled extension should not require core edits.
- **Extensions** (`extensions/`) are self-contained workspace packages. Plugin deps go in the extension's `package.json`, not root.
- **Gateway protocol** (`src/gateway/protocol/*`) changes are contract changes requiring versioned evolution.

## Anti-Redundancy Rules

- Import directly from source; no re-export wrapper files.
- If a function exists, import it — never duplicate.
- Before creating any utility/helper, search for existing implementations.

### Source of Truth Locations

| Concern | Location |
|---------|----------|
| Time formatting | `src/infra/format-time` |
| Terminal tables | `src/terminal/table.ts` (`renderTable`) |
| Colors/themes | `src/terminal/theme.ts` |
| CLI progress | `src/cli/progress.ts` |
| Formatting utilities | `src/infra/` |

## Import Conventions

- Use `.js` extension for cross-package imports (ESM requirement)
- `import type { X }` for type-only imports
- No `@ts-nocheck`; fix root causes instead of suppressing
- Avoid `any`; prefer `unknown`, discriminated unions, or narrow adapters

## Coding Conventions

- Keep files under ~700 LOC; extract helpers when larger
- Colocated tests: `*.test.ts` next to source files; e2e: `*.e2e.test.ts`
- Use `zod` for external boundary validation (config, webhooks, API responses)
- Prefer `Result<T, E>` for recoverable runtime decisions
- Dynamic imports: use dedicated `*.runtime.ts` boundaries for lazy loading
- Never share behavior via prototype mutation
- Naming: **OpenClaw** in prose/headings, `openclaw` in code/CLI/paths
- American English throughout (code, comments, docs, UI strings)

## Testing

- Framework: Vitest, V8 coverage (70% thresholds)
- Model examples in tests: prefer `sonnet-4.6` and `gpt-5.4`
- Clean up timers, env, mocks, sockets, temp dirs in tests
- Use `deps`/callback injection when available instead of module-level mocks
- For targeted debugging: `pnpm test <path-or-filter>` (not raw `pnpm vitest run`)
- Live tests: `OPENCLAW_LIVE_TEST=1 pnpm test:live`

## Prompt Cache Stability

Deterministic ordering is critical. Any code assembling model/tool payloads from maps, sets, registries, or plugin lists must sort before building the request. Do not rewrite older transcript bytes on every turn. Cache-sensitive changes require regression tests proving prefix stability.

## Commit Guidelines

- Concise, action-oriented messages (e.g., `CLI: add verbose flag to send`)
- Use `scripts/committer "<msg>" <file...>` for scoped staging
- No merge commits on `main`; rebase onto `origin/main` before pushing
- Group related changes; don't bundle unrelated refactors
