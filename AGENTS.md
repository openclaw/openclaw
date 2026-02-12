# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Architecture Overview

OpenClaw is a **multi-channel AI personal assistant** — a gateway that connects messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, etc.) to AI model providers (Claude/Anthropic, OpenAI, Gemini, local via Ollama). It runs as a long-lived gateway process with a WebSocket control plane.

**Core data flow:**

1. **Inbound:** channel webhook/poll → `ChannelMessagingAdapter` normalizes the message
2. **Routing:** `src/routing/resolve-route.ts` maps inbound message → session key (by channel + account)
3. **Agent:** PI agent (`src/agents/`) processes the message using configured model providers, tools, and memory
4. **Memory:** session recorded in SQLite (`memory.db`), compaction triggered as needed
5. **Outbound:** `ChannelOutboundAdapter` sends the final reply to the originating channel

**Key abstractions:**

- **Dock** (`src/channels/dock.ts`): lightweight channel metadata/behavior registry
- **Channel plugin interface** (`src/channels/plugins/types.ts`): adapter types for inbound, outbound, auth, status, commands, tools
- **Plugin SDK** (`src/plugin-sdk/index.ts`): 400+ exports for extension authors; HTTP route registration, tool registration, log transport
- **Config system** (`src/config/`): YAML/JSON config with Zod validation, env substitution, per-session overrides

## Project Structure & Module Organization

### Source Code Map (`src/`)

```
src/
├── acp/               # ACP (Anthropic Code Platform) integration
├── agents/            # PI agent execution, tool definitions, sandboxing
├── auto-reply/        # Reply generation, chunking, templating, memory flush
├── browser/           # Playwright automation for web browsing
├── canvas-host/       # Canvas rendering host (A2UI bundle)
├── channels/          # Core channel logic, dock, registry, allowlists
│   └── plugins/       # Per-channel adapter implementations + types
├── cli/               # CLI infrastructure, progress bars (src/cli/progress.ts)
├── commands/          # CLI commands (gateway, agent, wizard, sandbox, etc.)
├── config/            # Config loading, 15+ Zod schema files, validation
├── daemon/            # launchd (macOS) / systemd (Linux) daemon management
├── discord/           # Discord channel implementation
├── gateway/           # WebSocket server, control plane, request routing
│   ├── protocol/      # Core protocol definitions (schema-generated)
│   └── server-methods/# Config, send, talk, skills, web, wizard handlers
├── hooks/             # Hook system (bundled + custom hooks)
├── imessage/          # iMessage channel implementation
├── infra/             # Binaries, Bonjour, ports, env detection
├── memory/            # SQLite vector memory (QMD), embeddings, compaction
├── media/             # Media pipeline (images, audio, PDF processing)
├── plugin-sdk/        # Public plugin API (400+ exports)
├── plugins/           # Plugin runtime, HTTP routing, config schemas
├── providers/         # Model provider implementations (Anthropic, OpenAI, Gemini, Ollama)
├── routing/           # Session key resolution from inbound messages
├── security/          # FS audit, skill scanning, Windows ACL
├── sessions/          # Session overrides, model failover, send policy
├── signal/            # Signal channel implementation
├── slack/             # Slack channel implementation
├── telegram/          # Telegram channel implementation
├── terminal/          # Terminal UI helpers: table.ts, palette.ts
├── tui/               # Terminal UI (interactive TUI mode)
├── web/               # WhatsApp Web channel implementation
├── wizard/            # Onboarding wizard
├── entry.ts           # Main entry point (bundled → dist/index.js)
├── globals.ts         # Global constants
├── logger.ts          # Logging setup (tslog)
└── utils.ts           # Shared utilities
```

### Monorepo Workspace

pnpm workspace (`pnpm-workspace.yaml`) with four package groups:

| Workspace     | Description                                       |
|---------------|---------------------------------------------------|
| `.` (root)    | Core CLI + gateway + channels                     |
| `ui/`         | Control UI (Lit web components + Vite build)      |
| `packages/*`  | Sibling bots/agents (clawdbot, moltbot)           |
| `extensions/*`| 37 channel/integration plugins (workspace packages)|

### Other Top-Level Directories

- `apps/` — Native applications: `macos/` (SwiftUI), `ios/` (SwiftUI + xcodegen), `android/` (Kotlin + Gradle)
- `skills/` — 54 AI skill packages (1Password, GitHub, Google Drive, Coding Agent, etc.)
- `docs/` — Mintlify-hosted documentation site (docs.openclaw.ai)
- `test/` — Integration/E2E tests, fixtures, mocks, setup files
- `scripts/` — Build, test, release, and utility scripts
- `assets/` — Static assets (icons, sounds)
- `vendor/` — Vendored dependencies
- `.agents/` — Agent configuration and skill definitions

### Module Organization Rules

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).
  - Core channel docs: `docs/channels/`
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`
  - Extensions (channel plugins): `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels (use existing channel/extension label colors).

## Configuration System

### Config Hierarchy (highest to lowest priority)

```
process env vars              (highest)
  ↓
./.env                        (local dev)
  ↓
~/.openclaw/.env              (daemon)
  ↓
openclaw.json keys            (channels/agents/sandbox)
  ↓
src/config/defaults.ts        (lowest)
```

### Storage Paths

```
~/.openclaw/
  openclaw.json         # Main config file
  workspace/            # Agent workspace (per-agent isolated)
  skills/               # Installed skill packages (npm)
  sessions.json         # Session metadata + encryption key (JSON5)
  memory.db             # SQLite vector memory database
  credentials/          # Web provider credentials
  agents/<id>/sessions/ # Pi session transcripts (*.jsonl)
```

### Config Validation

- 15+ Zod schema files in `src/config/zod-schema*.ts`
- Supports channel-specific, agent-specific, sandbox, and cron configs
- Per-session overrides and model failover chains

## Database & Storage

- **SQLite 3** via Node.js built-in `node:sqlite` module + `sqlite-vec` (0.1.7-alpha.2) for vector operations
  - Location: `~/.openclaw/memory.db`
  - Features: vector memory (embeddings), async embedding batches, atomic reindexing, deduplication, compaction/session pruning
- **Session transcripts** use `parentId` chain/DAG in JSONL files; never append raw entries — always go through `SessionManager.appendMessage(...)` to maintain the leaf path
- **JSON5** for `sessions.json` (but `JSON.parse` used where possible for 35x speed)

## Gateway API

- **Protocol:** WebSocket (native) + Express HTTP (fallback)
- **Default port:** 18789 (bridge: 18790)
- **Bind:** loopback (127.0.0.1) by default; LAN/WAN configurable
- **Auth:** token-based or password auth
- **Protocol models:** `src/gateway/protocol/` — generated Swift models in `apps/macos/Sources/OpenClawProtocol/`; validate with `pnpm protocol:check`
- **RPC mode:** `openclaw agent --mode rpc --json` (JSON-RPC streaming)

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- When working with documentation, read the mintlify skill.
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and "gateway host".

## Docs i18n (zh-CN)

- `docs/zh-CN/**` is generated; do not edit unless the user explicitly asks.
- Pipeline: update English docs → adjust glossary (`docs/.i18n/glossary.zh-CN.json`) → run `scripts/docs-i18n` → apply targeted fixes only if instructed.
- Translation memory: `docs/.i18n/zh-CN.tm.jsonl` (generated).
- See `docs/.i18n/README.md`.
- The pipeline can be slow/inefficient; if it's dragging, ping @jospalmbier on Discord instead of hacking around it.

## exe.dev VM ops (general)

- Access: stable path is `ssh exe.dev` then `ssh vm-name` (assume SSH key already set).
- SSH flaky: use exe.dev web terminal or Shelley (web agent); keep a tmux session for long ops.
- Update: `sudo npm i -g openclaw@latest` (global install needs root on `/usr/lib/node_modules`).
- Config: use `openclaw config set ...`; ensure `gateway.mode=local` is set.
- Discord: store raw token only (no `DISCORD_BOT_TOKEN=` prefix).
- Restart: stop old gateway and run:
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`.

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Package manager: **pnpm 10.23.0** (enforced via corepack; `packageManager` field in `package.json`).
- Install deps: `pnpm install`
- Pre-commit hooks: `prek install` (runs same checks as CI)
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch. Release checklist: `docs/platforms/mac/release.md`.

### Key Build Commands

| Command              | Description                                           |
|----------------------|-------------------------------------------------------|
| `pnpm build`         | Full build (canvas bundle, tsdown, plugin SDK DTS, build info, CLI compat) |
| `pnpm tsgo`          | TypeScript type checking (tsgo native preview)        |
| `pnpm check`         | Full static checks (format + tsgo + lint)             |
| `pnpm lint`          | oxlint with type-aware rules                          |
| `pnpm lint:fix`      | Auto-fix lint + format                                |
| `pnpm format`        | oxfmt --write (format source)                         |
| `pnpm format:check`  | oxfmt --check (verify formatting)                     |
| `pnpm ui:build`      | Build control UI (Vite + Lit)                         |

### Test Commands

| Command                       | Description                                  |
|-------------------------------|----------------------------------------------|
| `pnpm test`                   | All unit tests (parallel via test-parallel.mjs) |
| `pnpm test:watch`             | Watch mode (vitest)                          |
| `pnpm test:coverage`          | Coverage report (70% lines/functions, 55% branches) |
| `pnpm test:e2e`               | End-to-end tests                             |
| `OPENCLAW_LIVE_TEST=1 pnpm test:live` | Live API tests (requires real keys)  |
| `pnpm test:docker:all`        | Full Docker integration suite                |

### Build Tooling

- **tsdown** — primary TypeScript bundler (entry: `src/entry.ts` → `dist/index.js`)
- **tsc** — plugin SDK `.d.ts` generation (`tsconfig.plugin-sdk.dts.json`)
- **tsx** — TypeScript execution for scripts
- **Vite** — UI build (`ui/vite.config.ts`)
- **tsgo** — Native TypeScript type checker (`@typescript/native-preview`)

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of "V2" copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.
- Naming: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, and config keys.

## Linting & Formatting Details

- **Linter:** oxlint 1.46.0 (Rust-based, type-aware). Config: `.oxlintrc.json`. Plugins: unicorn, typescript, oxc. All categories (correctness, perf, suspicious) → error.
- **Formatter:** oxfmt 0.31.0. Config: `.oxfmtrc.jsonc`.
- **Swift:** swiftlint (`.swiftlint.yml`) + swiftformat (`.swiftformat`). Run: `pnpm lint:swift`, `pnpm format:swift`.
- **Markdown:** markdownlint-cli2 (`.markdownlint-cli2.jsonc`). Run: `pnpm lint:docs`.
- **Pre-commit hooks** (`.pre-commit-config.yaml`): trailing-whitespace, detect-secrets, shellcheck, actionlint, zizmor, oxlint, oxfmt, swiftlint.

## CI/CD Pipeline

Main workflow: `.github/workflows/ci.yml` (GitHub Actions).

**Jobs:**

1. **docs-scope** — detect docs-only changes (skip heavy jobs)
2. **changed-scope** — detect macOS/Android/Node changes for PR optimization
3. **lint** (always runs) — oxlint, oxfmt, Swift, Markdown, secret detection
4. **format-check** — code formatting consistency
5. **node-test** — unit + E2E + live tests
6. **build** — tsdown, UI, plugin SDK
7. **docker-test** — multi-container integration tests
8. **formal-conformance** — protocol schema validation
9. **macOS** — build .app, code signing, DMG packaging
10. **Android** — Gradle build, APK generation
11. **iOS** — xcodegen, build archive

**Other workflows:** `docker-release.yml` (multi-arch Docker images), `install-smoke.yml`, `formal-conformance.yml`, `auto-response.yml`, `stale.yml`, `labeler.yml`.

**Concurrency:** groups by PR number; cancels previous runs. If scope detection fails, runs everything.

## Release Channels (Naming)

- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).
- dev: moving head on `main` (no tag; git checkout main).

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what's covered: `docs/testing.md`.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

### Test Configuration

- **Pool:** forks (process isolation)
- **Timeout:** 120s default (180s on Windows hooks)
- **Workers:** 4–16 local, 2–3 CI
- **Setup:** `test/setup.ts`, `test/global-setup.ts`
- **Fixtures:** `test/fixtures/`, `test/mocks/`
- **Configs:** `vitest.config.ts` (main), `vitest.unit.config.ts`, `vitest.e2e.config.ts`, `vitest.live.config.ts`, `vitest.gateway.config.ts`, `vitest.extensions.config.ts`

## Commit & Pull Request Guidelines

**Full maintainer PR workflow (optional):** If you want the repo's end-to-end maintainer workflow (triage order, quality bar, rebase rules, commit/changelog conventions, co-contributor policy, and the `review-pr` > `prepare-pr` > `merge-pr` pipeline), see `.agents/skills/PR_WORKFLOW.md`. Maintainers may use other workflows; when a maintainer specifies a workflow, follow that. If no workflow is specified, default to PR_WORKFLOW.

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Read this when submitting a PR: `docs/help/submitting-a-pr.md` ([Submitting a PR](https://docs.openclaw.ai/help/submitting-a-pr))
- Read this when submitting an issue: `docs/help/submitting-an-issue.md` ([Submitting an Issue](https://docs.openclaw.ai/help/submitting-an-issue))

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

## Security & Configuration Tips

- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.

## Troubleshooting

- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-*` | PI agent framework (core, AI, coding agent, TUI) |
| `grammy` | Telegram bot framework |
| `@slack/bolt` | Slack app framework |
| `@buape/carbon` | Discord bot framework (do **not** update) |
| `@whiskeysockets/baileys` | WhatsApp Web client |
| `@larksuiteoapi/node-sdk` | Feishu/Lark integration |
| `@line/bot-sdk` | LINE messaging |
| `sharp` | Image processing |
| `playwright-core` | Browser automation |
| `sqlite-vec` | SQLite vector search |
| `zod` | Schema validation (config) |
| `commander` | CLI framework |
| `express` + `ws` | Gateway HTTP + WebSocket server |

## Agent-Specific Notes

- Vocabulary: "makeup" = "mac app".
- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.
- When adding a new `AGENTS.md` anywhere in the repo, also add a `CLAUDE.md` symlink pointing to it (example: `ln -s AGENTS.md CLAUDE.md`).
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval; do not do this by default.
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don't hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.
- Gateway currently runs only as the menubar app; there is no separate LaunchAgent/helper label installed. Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep openclaw` rather than assuming a fixed label. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**
- macOS logs: use `./scripts/clawlog.sh` to query unified logs for the OpenClaw subsystem; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don't introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.
- Connection providers: when adding a new connection, update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.
- Version locations: `package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).
- "Bump version everywhere" means all version locations above **except** `appcast.xml` (only touch appcast when cutting a new macOS Sparkle release).
- **Restart apps:** "restart iOS/Android apps" means rebuild (recompile/install) and relaunch, not just kill/launch.
- **Device checks:** before testing, verify connected real devices (iOS/Android) before reaching for simulators/emulators.
- iOS Team ID lookup: `security find-identity -p codesigning -v` → use Apple Development (…) TEAMID. Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.
- A2UI bundle hash: `src/canvas-host/a2ui/.bundle.hash` is auto-generated; ignore unexpected changes, and only regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`) when needed. Commit the hash as a separate commit.
- Release signing/notary keys are managed outside the repo; follow internal release docs.
- Notary auth env vars (`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_API_KEY_P8`) are expected in your environment (per internal release docs).
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
- Lint/format churn:
  - If staged+unstaged diffs are formatting-only, auto-resolve without asking.
  - If commit/push already requested, auto-stage and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if needed), no extra confirmation.
  - Only ask when changes are semantic (logic/data/behavior).
- Lobster seam: use the shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors); apply palette to onboarding/config prompts and other TTY UI output as needed.
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief "other files present" note only if relevant.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a "session" file, open the Pi session logs under `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- Voice wake forwarding tips:
  - Command template should stay `openclaw-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don't add extra quotes.
  - launchd PATH is minimal; ensure the app's launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`openclaw` binaries resolve when invoked via `openclaw-mac`.
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool's escaping.
- Release guardrails: do not change version numbers without operator's explicit consent; always ask permission before running any npm publish/release step.

## NPM + 1Password (publish/verify)

- Use the 1password skill; all `op` commands must run inside a fresh tmux session.
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publish.
