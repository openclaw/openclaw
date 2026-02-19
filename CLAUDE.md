# OpenClaw

Multi-channel AI gateway with extensible messaging integrations.

## Tech Stack

- **Runtime**: Node 22+ (Bun also supported for dev/scripts)
- **Language**: TypeScript (ESM, strict mode)
- **Package Manager**: pnpm 10+ (keep `pnpm-lock.yaml` in sync)
- **Lint/Format**: Oxlint + Oxfmt (`pnpm check`)
- **Tests**: Vitest with V8 coverage
- **Type-check**: tsgo (`pnpm tsgo`)
- **CLI Framework**: Commander + clack/prompts
- **Build**: tsdown (outputs to `dist/`)

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run in dev mode
pnpm build            # Production build (tsdown → dist/)
pnpm test             # Run all tests (parallel)
pnpm test:fast        # Unit tests only (vitest)
pnpm test:e2e         # End-to-end tests
pnpm tsgo             # Type-check (fast native checker)
pnpm check            # Full check: format + types + lint
pnpm lint             # Oxlint with type-aware rules
pnpm lint:fix         # Oxlint autofix + format
pnpm format           # Oxfmt (write mode)
pnpm openclaw         # Run CLI locally
```

## Project Structure

```
src/
├── cli/               # CLI option wiring, progress bars
├── commands/           # Command handlers (onboard, auth-choice, etc.)
├── config/             # Constants, model presets
├── agents/             # Agent templates, proxy health checks
├── infra/              # Shared utilities (format-time, etc.)
├── terminal/           # Table rendering, themes/colors
└── plugin-sdk/         # Public plugin SDK
extensions/             # Messaging integrations (telegram, slack, max, discord, ...)
skills/                 # ~40 built-in skills (slash commands)
docs/                   # Documentation (English + Russian)
packages/               # Internal packages (clawdbot, moltbot)
apps/                   # Native apps (macOS, iOS, Android)
```

## Coding Conventions

### Anti-Redundancy (CRITICAL)

- **NEVER** create files that just re-export from another file. Import directly from the source.
- **NEVER** duplicate existing functions. Search first, then import.
- **NEVER** create local `formatAge`, `formatDuration`, `formatElapsedTime` — use `src/infra/format-time`.

### Source of Truth Locations

| Module               | Location                | Exports                             |
| -------------------- | ----------------------- | ----------------------------------- |
| Time formatting      | `src/infra/format-time` | `formatAge`, `formatDuration`, ...  |
| Table rendering      | `src/terminal/table.ts` | `renderTable`                       |
| Theme/colors         | `src/terminal/theme.ts` | `theme.success`, `theme.muted`, ... |
| Progress/spinners    | `src/cli/progress.ts`   | spinners, progress bars             |
| Dependency injection | `src/cli/`              | `createDefaultDeps`                 |

### TypeScript Style

- ESM imports with `.js` extension (e.g., `import { foo } from "./bar.js"`)
- `import type { X }` for type-only imports
- Strict typing — avoid `any`
- Keep files under ~500 LOC; extract helpers when larger
- Colocated tests: `*.test.ts` next to source files

### Git

- Pre-commit hook runs `oxlint --fix` + `oxfmt --write` automatically
- Do NOT use `scripts/committer` when working interactively — use git directly
- Run `pnpm check` before committing

## Cloud.ru Integration

This fork includes three Cloud.ru-related features:

1. **MAX Messenger Extension** (`extensions/max/`) — chat bot integration with MAX (VK Teams / eXpress)
2. **Cloud.ru AI Fabric** — integration with Evolution AI Factory platform
3. **Cloud.ru FM Proxy** — Docker proxy (`claude-code-proxy`) to route Claude Code requests through Cloud.ru Foundation Models (GLM-4.7, Qwen3-Coder)

Key files for Cloud.ru FM:

- `src/config/cloudru-fm.constants.ts` — Single Source of Truth for model IDs, presets, proxy config
- `src/commands/auth-choice.apply.cloudru-fm.ts` — Wizard handler
- `src/commands/onboard-cloudru-fm.ts` — Onboarding utilities
- `src/agents/cloudru-proxy-template.ts` — Docker Compose template
- `src/agents/cloudru-proxy-health.ts` — Proxy health check

Documentation (Russian): `docs/ru/`
