# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is OpenClaw

OpenClaw is a WhatsApp gateway CLI with a Pi RPC agent. It bridges messaging channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and more via extensions) to AI agents. It includes a gateway server, a TUI, native macOS/iOS/Android apps, a web UI, and a plugin/extension system.

## Build, Test, and Development Commands

**Prerequisites:** Node 22+, pnpm 10+. Bun is preferred for TypeScript execution (scripts, dev, tests).

```bash
pnpm install                  # Install dependencies
pnpm build                    # Full build (tsdown + plugin-sdk DTS + canvas bundle + build info)
pnpm check                    # Type-check (tsgo) + lint (oxlint) + format check (oxfmt)
pnpm test                     # Run unit tests (vitest, parallel forks)
pnpm test:coverage            # Unit tests with V8 coverage (70% threshold)
pnpm test:watch               # Vitest watch mode
pnpm test:e2e                 # End-to-end tests
pnpm test:live                # Live tests (requires OPENCLAW_LIVE_TEST=1 or LIVE=1)
pnpm lint:fix                 # Auto-fix lint + format issues
pnpm format:fix               # Auto-fix formatting only
```

**Run CLI in dev:** `pnpm openclaw ...` or `pnpm dev`

**Run a single test file:** `npx vitest run src/path/to/file.test.ts`

**Run tests matching a pattern:** `npx vitest run -t "test name pattern"`

**Gateway dev mode (no channels):** `pnpm gateway:dev`

**Pre-commit gate (what CI runs):** `pnpm build && pnpm check && pnpm test`

**Commits:** Use `scripts/committer "<msg>" <file...>` to scope staging. Follow concise, action-oriented messages (e.g., `CLI: add verbose flag to send`).

## Architecture Overview

### Monorepo Structure

pnpm workspace with these packages:
- `.` (root) — the core CLI and gateway
- `ui/` — web UI (Lit + Vite)
- `packages/clawdbot`, `packages/moltbot` — bot packages
- `extensions/*` — channel/feature plugins (workspace packages)

### Core Source Layout (`src/`)

**Entry flow:** `openclaw.mjs` → `dist/entry.js` → `src/entry.ts` (respawns with Node flags) → `src/cli/run-main.ts` → `src/cli/program.ts` (Commander-based CLI). `src/index.ts` is the library entrypoint that re-exports public API and also bootstraps the CLI when run directly.

**Key directories:**
- `src/cli/` — CLI wiring, subcommand registration, progress/prompt utilities. Uses Commander.
- `src/commands/` — Individual command implementations (onboarding, doctor, status, gateway config, agent management, etc.)
- `src/gateway/` — Gateway server: WebSocket server, HTTP endpoints (including OpenAI-compatible), session management, channel bridging, plugin hosting, node events
- `src/agents/` — AI agent runtime: Pi embedded runner, system prompts, tool definitions, sandbox management, model catalog/selection/failover, auth profiles, session management, skills
- `src/config/` — Configuration loading/validation/migration (Zod schemas in `zod-schema.*.ts`, TypeBox types in `types.*.ts`), session store, legacy migration
- `src/channels/` — Shared channel abstraction: allowlists, command gating, mention gating, typing indicators, channel registry
- `src/routing/` — Message routing and session key resolution
- `src/plugin-sdk/` — Plugin SDK exported as `openclaw/plugin-sdk`
- `src/infra/` — Infrastructure utilities (env, ports, binaries, errors, dotenv, runtime guards)
- `src/terminal/` — Terminal UI: palette (`palette.ts`), theme, table rendering, ANSI-safe wrapping
- `src/media/` and `src/media-understanding/` — Media pipeline (image/video/audio processing)
- `src/tui/` — Terminal UI (interactive mode)

**Messaging channels (core):** `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/` (WhatsApp web via Baileys), `src/whatsapp/`

**Messaging channels (extensions):** `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/voice-call`, `extensions/feishu`, `extensions/googlechat`, `extensions/line`, `extensions/nostr`, `extensions/twitch`, and more

### Native Apps (`apps/`)

- `apps/macos/` — SwiftUI macOS menubar app (gateway host)
- `apps/ios/` — SwiftUI iOS app (XcodeGen project)
- `apps/android/` — Kotlin Android app (Gradle)
- `apps/shared/` — Shared native code (OpenClawKit)

### Plugin/Extension System

Extensions live under `extensions/*` as workspace packages. Plugin-only deps go in the extension's `package.json`, not root. Runtime resolves `openclaw/plugin-sdk` via jiti alias. Avoid `workspace:*` in plugin `dependencies` (use `devDependencies` or `peerDependencies` instead). The build emits `dist/plugin-sdk/` for the public SDK surface.

### Dependency Injection

CLI dependencies are injected via `createDefaultDeps()` (`src/cli/deps.ts`), which provides per-channel send functions. Extend `createOutboundSendDeps` when adding new outbound channels.

### Build Pipeline

`tsdown` bundles three entrypoints: `src/entry.ts`, `src/index.ts`, `src/plugin-sdk/index.ts`, and `src/extensionAPI.ts` into `dist/`. The build also generates plugin-sdk DTS files, bundles the A2UI canvas, copies hook metadata, and writes build info/CLI compat files.

## Code Style

- **TypeScript ESM.** Strict typing; avoid `any`.
- **Formatting/linting:** Oxlint (with type-aware rules) and Oxfmt. Run `pnpm check` before commits.
- **File size:** Aim for ~500-700 LOC max; split/refactor when it improves clarity.
- **Naming:** **OpenClaw** for product/docs headings; `openclaw` for CLI/package/paths/config keys.
- **CLI progress:** Use `src/cli/progress.ts` (osc-progress + @clack/prompts spinner); don't hand-roll spinners.
- **Status output:** Use `src/terminal/table.ts` for tables + ANSI-safe wrapping.
- **Terminal colors:** Use the shared palette in `src/terminal/palette.ts` (no hardcoded colors).
- **Tool schemas (google-antigravity):** Avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` for string lists; avoid raw `format` property names in schemas.
- **SwiftUI:** Prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`.
- **Control UI (web):** Uses Lit with legacy decorators (`@state()`, `@property()`) due to Rollup constraints. See `CONTRIBUTING.md`.

## Testing

- **Framework:** Vitest with V8 coverage. Tests colocated as `*.test.ts`; e2e as `*.e2e.test.ts`.
- **Config files:** `vitest.config.ts` (unit), `vitest.e2e.config.ts`, `vitest.live.config.ts`, `vitest.extensions.config.ts`, `vitest.gateway.config.ts`
- **Test pool:** `forks` mode; max 16 workers locally, 2-3 in CI.
- **Timeouts:** 120s test timeout (180s hooks on Windows).
- **Docker tests:** `pnpm test:docker:all` (live models, gateway, onboarding, plugins, QR, network, doctor)

## Important Conventions

- When refactoring shared logic (routing, allowlists, pairing, command gating, onboarding), consider **all** built-in + extension channels.
- When adding channels/extensions, review `.github/labeler.yml` for label coverage.
- Patched dependencies (`pnpm.patchedDependencies`) must use exact versions (no `^`/`~`).
- Never update the Carbon dependency.
- Patching dependencies requires explicit approval.
- Docs are Mintlify-hosted (`docs.openclaw.ai`). Internal links are root-relative, no `.md` extension (e.g., `[Config](/configuration)`).
- `docs/zh-CN/**` is generated; do not edit unless explicitly asked.
