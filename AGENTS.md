# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Package manager: pnpm (always use pnpm, never npm/yarn)
pnpm install                # Install dependencies
pnpm build                  # Full build (tsdown + plugin SDK + bundling)
pnpm check                  # Type-check (tsgo) + lint (oxlint) + format (oxfmt)
pnpm lint                   # oxlint --type-aware
pnpm lint:fix               # oxlint --type-aware --fix && oxfmt --write
pnpm format                 # oxfmt --check
pnpm format:fix             # oxfmt --write

# Development
pnpm dev                    # Run CLI in dev mode
pnpm openclaw <args>        # Run CLI commands in dev
pnpm gateway:dev            # Gateway with channels skipped
pnpm ui:dev                 # Web UI dev server (Lit + Vite)

# Testing (Vitest)
pnpm test                   # All test suites in parallel (unit + extensions + gateway)
pnpm test:watch             # Vitest watch mode
pnpm test:coverage          # With V8 coverage (thresholds: 70% lines/functions/statements, 55% branches)
pnpm test:e2e               # End-to-end tests
OPENCLAW_LIVE_TEST=1 pnpm test:live  # Live tests with real API keys

# Pre-PR gate
pnpm build && pnpm check && pnpm test
```

## Architecture

**OpenClaw** is a personal AI assistant gateway that bridges multiple messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, etc.) to a Pi RPC agent system. TypeScript/ESM monorepo using pnpm workspaces.

### Monorepo Layout

- **Root package**: CLI + Gateway + Core library (`src/`)
- **`ui/`**: Web Control UI (Lit web components + Vite)
- **`extensions/`**: Channel plugin ecosystem (33+ plugins, each with own `package.json`)
- **`packages/`**: Workspace packages (clawdbot, moltbot)
- **`apps/`**: Native apps — macOS/iOS (SwiftUI), Android (Kotlin)
- **`docs/`**: Mintlify documentation site
- **`skills/`**: Bundled agent skills/tools

### Core Source (`src/`) Architecture

- **`cli/`**: CLI wiring, commands, prompts. Dependencies via `createDefaultDeps()` for injection/testing.
- **`gateway/`**: WebSocket/HTTP gateway server, client, protocol (TypeBox validation), token auth.
- **`channels/`**, **`routing/`**: Channel plugin system with common `ChannelPlugin`/`ChannelOutboundAdapter` interfaces.
- **Channel integrations**: `discord/`, `telegram/`, `slack/`, `signal/`, `imessage/`, `web/`, `line/`
- **`agents/`**: Pi RPC agent system, skill loading, tool definitions, embedded runner.
- **`memory/`**: SQLite memory store with vector embeddings (`sqlite-vec`).
- **`media/`**: Media pipeline (transcoding, preview). `media-understanding/`: AI analysis. `link-understanding/`: web scraping via Playwright + Readability.
- **`config/`**: Configuration management, session store, state migrations.
- **`plugin-sdk/`**: SDK for extension plugins. Runtime resolves `openclaw/plugin-sdk` via jiti alias.
- **`infra/`**: Infrastructure (bonjour, state, outbound, ports).

### Key Patterns

- **Dependency Injection**: `src/cli/deps.ts` — `createDefaultDeps()` provides outbound send functions mapped to channel adapters.
- **Plugin Registry**: `setActivePluginRegistry()` for runtime/test channel plugin registration.
- **State Migrations**: `src/infra/state-migrations.ts` for schema evolution.
- **Database**: Native Node `sqlite` module (Node 22.10+) with `sqlite-vec` for vector search.

## Coding Standards

- **TypeScript ESM** with strict mode. Avoid `any` types.
- **Linter**: Oxlint (not ESLint). **Formatter**: Oxfmt. Run `pnpm check` before commits.
- **Imports**: ESM with `.js` extensions. Use `import type` for type-only imports.
- **Interfaces**: Define simply — avoid `Omit`, `NonNullable`, and complex type notation.
- **File size**: Keep under ~500-700 LOC. Extract helpers; don't create "V2" copies.
- **Component splitting**: If a component exceeds ~100 LOC with sub-components, split into a directory with `index.tsx` (main component + Props interface) and separate sub-component files.
- **Legacy decorators**: UI uses Lit with `experimentalDecorators: true` and `useDefineForClassFields: false`. Use `@state()` / `@property()` syntax.
- **Naming**: **OpenClaw** for product/app/docs; `openclaw` for CLI/package/paths/config keys.
- **No `Math.random()`** in hydration-sensitive code.
- **CLI progress**: Use `src/cli/progress.ts`; don't hand-roll spinners.
- **Tool schemas**: Avoid `Type.Union` in tool input schemas (no `anyOf`/`oneOf`/`allOf`). Use `stringEnum`/`optionalStringEnum` for string lists.

## Testing

- **Framework**: Vitest with V8 coverage. Tests colocated: `*.test.ts` (unit), `*.e2e.test.ts` (e2e), `*.live.test.ts` (live).
- **Test setup** (`test/setup.ts`): Isolated test home directory per test, stub channel plugin registry.
- **Test utilities**: `src/test-utils/channel-plugins.ts` — `createTestRegistry()` for isolated plugin testing.
- **Max workers**: 16 locally; do not increase.

## Extensions / Plugins

- Plugin deps belong in the extension's own `package.json`, not root.
- Use `devDependencies` or `peerDependencies` for `workspace:*` refs (not `dependencies` — breaks npm install).
- Patched dependencies (`pnpm.patchedDependencies`) must use exact versions (no `^`/`~`).

## Version & Release

- Version format: `YYYY.M.D[-patch]` (e.g., `2026.2.6-3`).
- When creating a PR, update the version with the PR number.
- Version must be updated in multiple locations: `package.json`, `apps/android/app/build.gradle.kts`, iOS/macOS `Info.plist` files, `docs/install/updating.md`.
- Release channels: stable (`latest`), beta, dev.
- Release process: see `docs/reference/RELEASING.md`.

## Docs (Mintlify)

- Internal links: root-relative, no `.md`/`.mdx` extension (e.g., `[Config](/configuration)`).
- Avoid em dashes and apostrophes in headings (breaks Mintlify anchors).
- `docs/zh-CN/` is auto-generated — do not edit unless explicitly asked.

## Commits & PRs

- Use `scripts/committer "<msg>" <file...>` for scoped staging.
- Action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Pre-PR: `pnpm build && pnpm check && pnpm test`.
- Prefer rebase for clean history, squash for messy history.
- AI-assisted PRs: mark as AI-assisted, note testing level, include session logs if possible.
- When creating PRs, they should target `jhs129/openclaw:main` (no upstream remote configured).

## Deployment (Fly.io)

Production gateway runs on [Fly.io](https://fly.io) (`openclaw-jhs` app, `iad` region).

```bash
# Deploy (builds remotely on Fly)
fly deploy --app openclaw-jhs

# Manage secrets
fly secrets set ANTHROPIC_API_KEY=sk-ant-... --app openclaw-jhs
fly secrets set OPENCLAW_GATEWAY_TOKEN=... --app openclaw-jhs

# SSH into the machine
fly ssh console --app openclaw-jhs

# Logs
fly logs --app openclaw-jhs

# Status
fly status --app openclaw-jhs
```

- **Config**: `fly.toml` in repo root (app name: `openclaw-jhs`, region: `iad`)
- **Persistent volume**: `openclaw_data` mounted at `/data` (1 GB, encrypted)
- **State dir**: `OPENCLAW_STATE_DIR=/data` — SQLite DBs, config, sessions all live here
- **Entrypoint**: `node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan`
- **URL**: `https://openclaw-jhs.fly.dev/`
- **VM**: `shared-cpu-2x`, 2048 MB RAM
- **Cost**: ~$10-15/month
- **Gateway startup**: Takes ~30s; Fly health check warnings during deploy are expected

Previous Azure ACI deployment has been fully torn down (container, storage, ACR, resource group all deleted).

## Multi-Agent Safety

- Do not create/apply/drop `git stash` entries unless explicitly requested.
- Do not switch branches or modify `git worktree` checkouts unless explicitly requested.
- When committing, scope to your changes only. When pushing, `git pull --rebase` is OK but never discard others' work.
