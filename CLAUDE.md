# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also: `AGENTS.md` for full operational guidelines (PR workflows, VM ops, release signing, multi-agent safety rules, etc.).

## What is Moltbot

Moltbot is a personal AI assistant that runs on your own devices and responds across messaging channels (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat) plus extension channels (BlueBubbles, Matrix, Zalo, etc.). It includes a Gateway control plane, native apps (macOS/iOS/Android), a TUI, and an ACP bridge for IDE integration.

## Build & Development Commands

- **Runtime:** Node >= 22 (keep both Node + Bun paths working)
- **Package manager:** pnpm (v10.23+); `pnpm install` for deps
- **Build:** `pnpm build` (runs canvas bundle + tsc + post-build scripts)
- **Dev server:** `pnpm dev` or `pnpm gateway:watch` (auto-reload on TS changes)
- **Lint:** `pnpm lint` (oxlint with type-aware rules)
- **Format check:** `pnpm format` (oxfmt); fix with `pnpm format:fix`
- **Lint+format fix:** `pnpm lint:fix`
- **Tests:** `pnpm test` (vitest, parallel via `scripts/test-parallel.mjs`)
- **Single test watch:** `vitest <path>` or `pnpm test:watch`
- **Coverage:** `pnpm test:coverage` (V8 provider, 70% thresholds)
- **E2E tests:** `pnpm test:e2e`
- **Live tests (real keys):** `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- **Full gate:** `pnpm lint && pnpm build && pnpm test`
- **UI:** `pnpm ui:build` (builds `ui/` Vite app); `pnpm ui:dev` for dev server
- **iOS:** `pnpm ios:build`; **Android:** `pnpm android:assemble`
- **Swift lint/format:** `pnpm lint:swift` / `pnpm format:swift`
- **Docs (Mintlify):** `pnpm docs:dev` / `pnpm docs:build`
- **Protocol codegen:** `pnpm protocol:gen` (TS) / `pnpm protocol:gen:swift`
- **Commit helper:** `scripts/committer "<msg>" <file...>` (scoped staging)

## Architecture

### Monorepo layout (pnpm workspaces)
- `src/` — Core TypeScript source (ESM, strict typing)
- `extensions/` — Channel plugins as workspace packages (e.g., `msteams`, `matrix`, `zalo`, `voice-call`, `bluebubbles`)
- `apps/` — Native apps: `macos/` (SwiftUI), `ios/` (SwiftUI + Xcodegen), `android/` (Kotlin/Gradle), `shared/` (MoltbotKit)
- `ui/` — Web control UI (Vite + Lit)
- `packages/` — Shared workspace packages (e.g., `packages/clawdbot`)
- `docs/` — Mintlify docs (hosted at docs.molt.bot)
- `skills/` — Bundled skill definitions
- `vendor/` — Vendored dependencies

### Key source directories (`src/`)
- `cli/` — CLI wiring (Commander)
- `commands/` — CLI command implementations
- `gateway/` — Gateway server (WebSocket + HTTP), control UI, protocol
- `agents/` — AI agent runtime, tools, skills, sandbox
- `routing/` — Message routing across channels
- `channels/` — Channel abstraction layer
- `telegram/`, `discord/`, `slack/`, `signal/`, `imessage/`, `web/`, `line/` — Core channel integrations
- `providers/` — Model provider integrations
- `config/` — Configuration system
- `media/`, `media-understanding/`, `link-understanding/` — Media pipeline
- `plugins/`, `plugin-sdk/` — Plugin system and SDK (exported as `moltbot/plugin-sdk`)
- `acp/` — Agent Client Protocol bridge (stdio, for IDE integration)
- `sessions/` — Session store and management
- `tui/` — Terminal UI
- `wizard/` — Onboarding wizard
- `canvas-host/` — Canvas rendering host (includes A2UI bundle)
- `terminal/` — Table rendering, palette, ANSI helpers
- `tts/` — Text-to-speech
- `memory/` — Memory/context system

### Extension plugins
Extensions are workspace packages under `extensions/`. They keep their own deps in their `package.json` — don't add extension-only deps to root. Runtime deps go in `dependencies`; put `moltbot` in `devDependencies` or `peerDependencies` (not `dependencies` with `workspace:*`).

### Testing
- Tests are colocated as `*.test.ts` next to source files
- E2E tests: `*.e2e.test.ts`; live tests: `*.live.test.ts`
- Vitest with `forks` pool; max 16 workers locally, 2-3 in CI
- Test timeout: 120s (180s hooks on Windows)

## Coding Conventions

- **TypeScript ESM** — strict typing, avoid `any`
- **Formatting/linting:** oxlint + oxfmt (not ESLint/Prettier)
- **File size:** aim for < 500 LOC; split/refactor when it improves clarity
- **Naming:** "Moltbot" for product/docs headings; `moltbot` for CLI/package/paths/config keys
- **CLI progress:** use `src/cli/progress.ts`; don't hand-roll spinners
- **Tables/status:** use `src/terminal/table.ts` and `src/terminal/palette.ts` (no hardcoded colors)
- **Tool schemas:** avoid `Type.Union` / `anyOf`/`oneOf`/`allOf` in tool input schemas; use `stringEnum`/`optionalStringEnum` for string enums
- **SwiftUI (iOS/macOS):** prefer `Observation` framework (`@Observable`) over `ObservableObject`
- **Dependencies:** patched deps (in `pnpm.patchedDependencies`) must use exact versions (no `^`/`~`). Never update the Carbon dependency.
