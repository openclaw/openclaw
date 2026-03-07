# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build (tsdown) + type-check
pnpm tsgo             # Type-check only (fast)
pnpm check            # Lint + format check (run before commits)
pnpm lint:fix         # Fix lint issues + auto-format
pnpm format:fix       # Fix formatting only (oxfmt --write)
pnpm dev              # Run dev server
pnpm openclaw ...     # Run CLI in dev mode (via bun)
pnpm test             # Run unit tests (Vitest, parallel runner)
pnpm test <path>      # Run a single test file
pnpm test:fast        # Run unit tests (direct vitest, no parallel wrapper)
pnpm test:e2e         # Run e2e tests
pnpm test:watch       # Run vitest in watch mode
pnpm test:coverage    # Tests + V8 coverage (70% threshold)
pnpm test:live        # Live tests (requires CLAWDBOT_LIVE_TEST=1 or LIVE=1)
```

Prefer Bun for TypeScript execution in dev/scripts (`bun <file.ts>`). Node remains supported for production builds (`dist/*`). Runtime baseline: **Node 22+**.

## Architecture

OpenClaw is a self-hosted personal AI assistant platform. It runs as a local Gateway service that bridges multiple messaging channels to AI backends.

### Data Flow

```
CLI entry (src/entry.ts → src/index.ts → src/cli/run-main.ts)
  └→ Commands (src/commands/)
       └→ Gateway server (src/gateway/server.impl.ts)
            ├→ Channel manager (src/gateway/server-channels.ts)
            │    └→ Channel impls: src/telegram/, src/discord/, src/slack/,
            │       src/signal/, src/imessage/, src/web/, src/channels/,
            │       src/routing/, extensions/* (Teams, Matrix, Zalo, Voice, …)
            ├→ Agent runner (src/agents/pi-embedded-runner/)
            │    ├→ Model selection (src/agents/model-selection.ts)
            │    ├→ Tools / skills (src/agents/pi-tools.ts)
            │    ├→ Memory search (src/agents/memory-search.ts)
            │    └→ Subagent registry (src/agents/subagent-registry.ts)
            ├→ Session manager → ~/.openclaw/sessions/
            ├→ Cron service (src/gateway/server-cron.ts)
            └→ Health monitor (src/gateway/channel-health-monitor.ts)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/gateway/` | Core WebSocket server, client handling, session, cron, health |
| `src/agents/` | AI agent runtime (Pi framework), tool execution, subagents |
| `src/cli/` | CLI option wiring, program builder, progress/spinner UI |
| `src/commands/` | CLI command implementations (onboard, agent, channels, auth, …) |
| `src/config/` | Config loading/validation/persistence (JSON5 at `~/.openclaw/config.json5`) |
| `src/memory/` | SQLite + sqlite-vec for vector embeddings and semantic search |
| `src/infra/` | Ports, exec, heartbeat, device auth, format-time utilities |
| `src/terminal/` | Table rendering, ANSI theme/colors, CLI palette |
| `src/tui/` | Terminal UI components |
| `src/plugins/` | Hook-based plugin system + plugin registry |
| `extensions/` | Channel/feature plugins (workspace packages, 40+) |
| `skills/` | Bundled skills for the AI assistant (100+) |
| `apps/` | Native apps: iOS (`apps/ios/`), macOS (`apps/macos/`), Android (`apps/android/`) |
| `ui/` | Web UI (Live Canvas / A2UI rendering) |

### Storage

- **Config**: `~/.openclaw/config.json5` (validated via `src/config/zod-schema.ts`)
- **Sessions**: `~/.openclaw/sessions/` (JSON transcripts, write-locked during execution)
- **Agent logs**: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- **Memory/embeddings**: SQLite + sqlite-vec (`src/memory/manager.ts`)
- **Credentials**: `~/.openclaw/credentials/`

## Coding Conventions

- **TypeScript ESM, strict mode** — no `any`, no `@ts-nocheck`, no disabling `no-explicit-any`.
- **`.js` extensions** on cross-package imports (ESM resolution).
- **No prototype mutation** for shared behavior (`applyPrototypeMixins`, `Object.defineProperty` on `.prototype`). Use class inheritance/composition so TypeScript can typecheck.
- **Anti-redundancy** — search for existing implementations before writing a new formatter, utility, or helper.
- **File size** — aim for ~700 LOC; split/refactor when it helps clarity or testability.
- **Colocated tests** — `*.test.ts` next to source; e2e as `*.e2e.test.ts`.
- **Naming** — `OpenClaw` in headings/docs; `openclaw` for CLI, package, paths, config keys.
- **Control UI (Lit)** — uses legacy decorators (`@state()`, `@property()`); do not use `accessor` fields or standard decorators (Rollup doesn't support them). Root tsconfig has `experimentalDecorators: true` and `useDefineForClassFields: false`.

### Source-of-Truth Locations

| What | Where |
|------|-------|
| Time formatting | `src/infra/format-time` |
| Table rendering | `src/terminal/table.ts` (`renderTable`) |
| Theme/colors | `src/terminal/theme.ts` (`theme.success`, `theme.muted`, …) |
| CLI palette | `src/terminal/palette.ts` |
| Progress/spinners | `src/cli/progress.ts` |
| CLI option wiring | `src/cli/` |
| Dependency injection | `createDefaultDeps` pattern |

### Plugin / Extension Rules

- Keep plugin-only deps in the extension's own `package.json` (not root).
- Never use `workspace:*` in `dependencies`; put `openclaw` in `devDependencies` or `peerDependencies`.
- When refactoring shared logic (routing, allowlists, pairing, onboarding), always consider **all** built-in + extension channels.
- When adding a new `AGENTS.md` anywhere in the repo, add a `CLAUDE.md` symlink pointing to it.

## Commits

Use `scripts/committer "<msg>" <file...>` to keep staging scoped. Follow concise action-oriented messages (e.g., `CLI: add verbose flag to send`). Do not bundle unrelated refactors.

## Docs (Mintlify)

- Internal links: root-relative, no `.md`/`.mdx` extension (e.g., `[Config](/configuration)`).
- Anchors: `[Hooks](/configuration#hooks)` — avoid em dashes/apostrophes in headings (breaks anchors).
- `docs/zh-CN/**` is generated; do not edit unless explicitly asked.
- README: use absolute `https://docs.openclaw.ai/...` URLs (links must work on GitHub).

## Troubleshooting

- Run `openclaw doctor` for rebrand/migration issues or legacy config warnings.
- Gateway on macOS: start/stop via the OpenClaw Mac app or `scripts/restart-mac.sh`; use `launchctl print gui/$UID | grep openclaw` to inspect, not a fixed label.
- macOS logs: `./scripts/clawlog.sh` (queries unified logs for the OpenClaw subsystem).
