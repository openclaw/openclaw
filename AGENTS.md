# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Project Structure & Module Organization

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

### Key `src/` Subdirectory Reference

| Directory | Purpose |
|---|---|
| `src/agents/` | AI agent runtime: pi-embedded runner, model selection, auth profiles, subagents, skills, sandbox, tools, bash execution |
| `src/acp/` | Agent Client Protocol (ACP) integration |
| `src/browser/` | Browser/playwright automation integration |
| `src/canvas-host/` | Canvas/A2UI host and bundled UI assets (`a2ui/.bundle.hash` auto-generated) |
| `src/channels/` | Channel routing, shared messaging abstractions |
| `src/cli/` | CLI command wiring, option parsing, progress, prompts, daemon/gateway CLI |
| `src/commands/` | High-level CLI command implementations (agent, send, hooks, models, etc.) |
| `src/config/` | Config loading, migrations, evaluation |
| `src/cron/` | Scheduled task (cron) runner |
| `src/daemon/` | Background daemon process management |
| `src/discord/` | Discord channel integration |
| `src/docs/` | In-app docs helpers |
| `src/gateway/` | WebSocket gateway server: auth, hooks, sessions, HTTP endpoints, OpenAI/OpenResponses API shims, control UI |
| `src/hooks/` | Automation hooks (webhook, poll, heartbeat, Gmail PubSub, bundled handlers) |
| `src/imessage/` | iMessage channel integration |
| `src/infra/` | Infrastructure utilities: networking, ports, bonjour/mDNS, heartbeat, state migrations, retries, update logic |
| `src/line/` | LINE messaging channel integration |
| `src/link-understanding/` | URL/link content extraction |
| `src/logger.ts` | Logging setup (tslog-based) |
| `src/macos/` | macOS-specific helpers |
| `src/markdown/` | Markdown rendering utilities |
| `src/media/` | Media pipeline: audio, video, image processing |
| `src/media-understanding/` | Media understanding/analysis |
| `src/memory/` | Memory system (search, batch processing) |
| `src/node-host/` | Node (device) host management |
| `src/pairing/` | Device pairing protocol |
| `src/plugin-sdk/` | Public plugin SDK (exported as `openclaw/plugin-sdk`) |
| `src/plugins/` | Built-in plugin wiring |
| `src/process/` | Process spawning, exec, RPC bridges |
| `src/providers/` | AI provider integrations (OpenAI, Anthropic, Gemini, Bedrock, Ollama, etc.) |
| `src/routing/` | Message routing between channels |
| `src/scripts/` | Dev-time script helpers |
| `src/security/` | Security: DM allowlists, exec approvals, safe bins |
| `src/sessions/` | Session management |
| `src/shared/` | Shared types, utilities, and helpers used across modules |
| `src/signal/` | Signal channel integration |
| `src/slack/` | Slack channel integration |
| `src/telegram/` | Telegram channel integration |
| `src/terminal/` | Terminal output: palette, tables, ANSI utilities |
| `src/tts/` | Text-to-speech |
| `src/tui/` | Terminal UI (TUI) interface |
| `src/types/` | Shared TypeScript types |
| `src/utils/` | General utility functions |
| `src/web/` | WhatsApp Web/web channel integration |
| `src/whatsapp/` | WhatsApp integration |
| `src/wizard/` | Onboarding wizard flows |

### Extensions (`extensions/`)

Extensions are workspace packages implementing channel plugins and integrations. Each lives in its own `package.json` and depends on `openclaw/plugin-sdk` via `peerDependencies`/`devDependencies`.

Current extensions include:
`bluebubbles`, `copilot-proxy`, `device-pair`, `diagnostics-otel`, `discord`, `feishu`, `google-antigravity-auth`, `google-gemini-cli-auth`, `googlechat`, `imessage`, `irc`, `line`, `llm-task`, `lobster`, `matrix`, `mattermost`, `memory-core`, `memory-lancedb`, `minimax-portal-auth`, `msteams`, `nextcloud-talk`, `nostr`, `open-prose`, `phone-control`, `qwen-portal-auth`, `shared`, `signal`, `slack`, `talk-voice`, `telegram`, `thread-ownership`, `tlon`, `twitch`, `voice-call`, `whatsapp`, `zalo`, `zalouser`

### Mobile & Desktop Apps (`apps/`)

- `apps/android/`: Kotlin + Jetpack Compose Android node app (minSdk 31). Connects to gateway via WebSocket mDNS discovery. Build with `pnpm android:*` scripts or Gradle directly.
- `apps/ios/`: Swift/SwiftUI iOS app (super-alpha, internal). Uses XcodeGen (`project.yml`). Build with `pnpm ios:*` scripts or `xcodegen generate` + Xcode.
- `apps/macos/`: Swift Package Manager macOS menubar/gateway app. Build with `pnpm mac:package` or `scripts/package-mac-app.sh`. Restart with `scripts/restart-mac.sh`.

### UI Subsystem (`ui/`)

- Web control UI built with Lit (legacy decorators — keep `@state()` / `@property()` style; do not switch to standard decorators).
- Build: `pnpm ui:build`. Dev: `pnpm ui:dev`.
- `tsconfig.json` has `experimentalDecorators: true` and `useDefineForClassFields: false`; do not change these without updating the build tooling.

### Packages (`packages/`)

- `packages/clawdbot/`: ClawDBot package.
- `packages/moltbot/`: MoltBot package.

### Workspace layout

`pnpm-workspace.yaml` defines: `.` (root), `ui`, `packages/*`, `extensions/*`.

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
- Install deps: `pnpm install`
- If deps are missing (for example `node_modules` missing, `vitest not found`, or `command not found`), run the repo's package-manager install command (prefer lockfile/README-defined PM), then rerun the exact requested command once. Apply this to test/build/lint/typecheck/dev commands; if retry still fails, report the command and first actionable error.
- Pre-commit hooks: `prek install` (runs same checks as CI)
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch. Release checklist: `docs/platforms/mac/release.md`.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Format check: `pnpm format` (oxfmt --check)
- Format fix: `pnpm format:fix` (oxfmt --write)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

### Build System

- Bundler: `tsdown` (rolldown-based). Config: `tsdown.config.ts`.
- Build entry points (all emit to `dist/`):
  - `src/index.ts` — main package export
  - `src/entry.ts` — CLI entrypoint
  - `src/cli/daemon-cli.ts` — daemon CLI shim
  - `src/infra/warning-filter.ts` — warning filter
  - `src/plugin-sdk/index.ts` → `dist/plugin-sdk/`
  - `src/plugin-sdk/account-id.ts` → `dist/plugin-sdk/`
  - `src/extensionAPI.ts` — extension API
  - `src/hooks/bundled/*/handler.ts` + `src/hooks/llm-slug-generator.ts` — bundled hook handlers
- Post-build scripts: canvas a2ui copy, hook metadata copy, HTML template copy, build-info write, CLI compat write.
- Module resolution: `NodeNext` (ESM). TypeScript strict mode. `experimentalDecorators: true` (for Lit UI). Plugin SDK also aliased via jiti at runtime.

### TypeScript Path Aliases

Used in `tsconfig.json` (and mirrored in `vitest.config.ts` for tests):
- `openclaw/plugin-sdk` → `src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/*` → `src/plugin-sdk/*.ts`
- `openclaw/plugin-sdk/account-id` → `src/plugin-sdk/account-id.ts`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Never add `@ts-nocheck` and do not disable `no-explicit-any`; fix root causes and update Oxlint/Oxfmt config only when required.
- Never share class behavior via prototype mutation (`applyPrototypeMixins`, `Object.defineProperty` on `.prototype`, or exporting `Class.prototype` for merges). Use explicit inheritance/composition (`A extends B extends C`) or helper composition so TypeScript can typecheck.
- If this pattern is needed, stop and get explicit approval before shipping; default behavior is to split/refactor into an explicit class hierarchy and keep members strongly typed.
- In tests, prefer per-instance stubs over prototype mutation (`SomeClass.prototype.method = ...`) unless a test explicitly documents why prototype-level patching is required.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of "V2" copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.
- Naming: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, and config keys.

## Release Channels (Naming)

- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).
- dev: moving head on `main` (no tag; git checkout main).

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches(55%)/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`; live (real-key) in `*.live.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what's covered: `docs/testing.md`.
- Changelog: user-facing changes only; no internal/meta notes (version alignment, appcast reminders, release process).
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

### Vitest Configuration Files

| Config file | Purpose | Pool |
|---|---|---|
| `vitest.config.ts` | Root config; base for all others | `forks` |
| `vitest.unit.config.ts` | Unit tests only (excludes e2e, gateway, extensions) | `forks` |
| `vitest.e2e.config.ts` | E2E tests (`*.e2e.test.ts`) | `vmForks` |
| `vitest.live.config.ts` | Live tests (real API keys, `*.live.test.ts`) | varies |
| `vitest.gateway.config.ts` | Gateway integration tests | varies |
| `vitest.extensions.config.ts` | Extension tests | varies |

- `pnpm test` runs `scripts/test-parallel.mjs` which orchestrates multiple vitest configs.
- `pnpm test:fast` runs only unit tests (fastest; no e2e).
- `pnpm test:coverage` runs unit tests with coverage reporting.
- E2E workers: controlled via `OPENCLAW_E2E_WORKERS` env var (defaults to CPU-scaled, max 16).
- E2E verbosity: set `OPENCLAW_E2E_VERBOSE=1`.

### Coverage Thresholds & Scope

Coverage is scoped to `./src/**/*.ts` only (not `extensions/`, `apps/`, `ui/`, `test/`).

Thresholds (unit suite):
- Lines: 70% | Functions: 70% | Branches: 55% | Statements: 70%

Large integration surfaces (`src/gateway/**`, `src/agents/**`, channels, CLI, TUI, etc.) are excluded from unit coverage and validated via e2e/manual/Docker tests.

## Commit & Pull Request Guidelines

**Full maintainer PR workflow (optional):** If you want the repo's end-to-end maintainer workflow (triage order, quality bar, rebase rules, commit/changelog conventions, co-contributor policy, and the `review-pr` > `prepare-pr` > `merge-pr` pipeline), see `.agents/skills/PR_WORKFLOW.md`. Maintainers may use other workflows; when a maintainer specifies a workflow, follow that. If no workflow is specified, default to PR_WORKFLOW.

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PR submission template (canonical): `.github/pull_request_template.md`
- Issue submission templates (canonical): `.github/ISSUE_TEMPLATE/`

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

## Git Notes

- If `git branch -d/-D <branch>` is policy-blocked, delete the local ref directly: `git update-ref -d refs/heads/<branch>`.
- Bulk PR close/reopen safety: if a close action would affect more than 5 PRs, first ask for explicit user confirmation with the exact PR count and target scope/query.

## Security & Configuration Tips

- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.
- Environment variable precedence (highest → lowest): process env → `./.env` → `~/.openclaw/.env` → `openclaw.json` `env` block. Existing non-empty process env vars are not overridden.

## GHSA (Repo Advisory) Patch/Publish

- Fetch: `gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`
- Latest npm: `npm view openclaw version --userconfig "$(mktemp)"`
- Private fork PRs must be closed:
  `fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)`
  `gh pr list -R "$fork" --state open` (must be empty)
- Description newline footgun: write Markdown via heredoc to `/tmp/ghsa.desc.md` (no `"\\n"` strings)
- Build patch JSON via jq: `jq -n --rawfile desc /tmp/ghsa.desc.md '{summary,severity,description:$desc,vulnerabilities:[...]}' > /tmp/ghsa.patch.json`
- Patch + publish: `gh api -X PATCH /repos/openclaw/openclaw/security-advisories/<GHSA> --input /tmp/ghsa.patch.json` (publish = include `"state":"published"`; no `/publish` endpoint)
- If publish fails (HTTP 422): missing `severity`/`description`/`vulnerabilities[]`, or private fork has open PRs
- Verify: re-fetch; ensure `state=published`, `published_at` set; `jq -r .description | rg '\\\\n'` returns nothing

## Troubleshooting

- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).

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
- **Agent growth system:** workspace agents running long-term should maintain `bank/` (tiered memory) and `GROWTH_LOG.md` in their workspace. See `docs/reference/templates/AGENTS.md` (🌱 成長協議 section) and `docs/agent-growth-blueprint.md` for the full protocol.
- **Model fallback / quota resilience:** configure `agents.defaults.model` to avoid hard failures when quota runs out. `fallbacks` is an explicit ordered list. `fallbackPolicy: "auto"` auto-discovers other providers from `auth.profiles`; `autoFallbackModels` sets per-provider model overrides. Cooldown tuning: `auth.cooldowns.billingBackoffHours` (default 5h), `billingBackoffHoursByProvider` for per-provider overrides. See `src/agents/model-fallback.ts`.
- **Channel health watchdog (WhatsApp / Telegram stability):** The gateway has a built-in health monitor (`src/gateway/channel-health-monitor.ts`) that automatically detects and restarts disconnected channels every 5 minutes by default. Configure with `gateway.channelHealthCheckMinutes` (0 = disable). Up to 3 auto-restarts/hour per channel before backing off. The monitor uses `channelManager.getRuntimeSnapshot()` to check `running` and `connected` states and calls `startChannel`/`stopChannel` as needed. Default startup grace period is 60 s so transient start-up noise is ignored.
- **Cross-channel session continuity (WhatsApp ↔ Telegram):** `session.identityLinks` links the same person's identities across channels so they share one conversation thread. Key = canonical peer (e.g. `"whatsapp:+15551234567"`); value = array of equivalent peers on other channels (e.g. `["telegram:123456789"]`). Example config:
  ```json
  { "session": { "identityLinks": { "whatsapp:+15551234567": ["telegram:123456789"] } } }
  ```
  When set, any message from `telegram:123456789` resolves to the same DM session as `whatsapp:+15551234567`, so conversation history flows across channels. Implemented in `src/config/types.base.ts` and consumed during DM session key resolution.
- **Session memory continuity (prevent context loss on restart):** The default idle reset is 60 minutes (`session.idleMinutes`). If sessions feel like they "forget" context after a break, increase this value or use per-channel overrides. Example that keeps WhatsApp sessions alive for 24 h while keeping Telegram at 60 min:
  ```json
  { "session": { "idleMinutes": 60, "resetByChannel": { "whatsapp": { "mode": "idle", "idleMinutes": 1440 } } } }
  ```
  The agent also loads MEMORY.md and `memory/*.md` files on each session for long-term memory persistence across restarts; see `src/memory/` and `agents.defaults.memorySearch`.
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

## Plugin Release Fast Path (no core `openclaw` publish)

- Release only already-on-npm plugins. Source list is in `docs/reference/RELEASING.md` under "Current npm plugin list".
- Run all CLI `op` calls and `npm publish` inside tmux to avoid hangs/interruption:
  - `tmux new -d -s release-plugins-$(date +%Y%m%d-%H%M%S)`
  - `eval "$(op signin --account my.1password.com)"`
- 1Password helpers:
  - password used by `npm login`:
    `op item get Npmjs --format=json | jq -r '.fields[] | select(.id=="password").value'`
  - OTP:
    `op read 'op://Private/Npmjs/one-time password?attribute=otp'`
- Fast publish loop (local helper script in `/tmp` is fine; keep repo clean):
  - compare local plugin `version` to `npm view <name> version`
  - only run `npm publish --access public --otp="<otp>"` when versions differ
  - skip if package is missing on npm or version already matches.
- Keep `openclaw` untouched: never run publish from repo root unless explicitly requested.
- Post-check for each release:
  - per-plugin: `npm view @openclaw/<name> version --userconfig "$(mktemp)"` should be `2026.2.17`
  - core guard: `npm view openclaw version --userconfig "$(mktemp)"` should stay at previous version unless explicitly requested.

## Changelog Release Notes

- When cutting a mac release with beta GitHub prerelease:
  - Tag `vYYYY.M.D-beta.N` from the release commit (example: `v2026.2.15-beta.1`).
  - Create prerelease with title `openclaw YYYY.M.D-beta.N`.
  - Use release notes from `CHANGELOG.md` version section (`Changes` + `Fixes`, no title duplicate).
  - Attach at least `OpenClaw-YYYY.M.D.zip` and `OpenClaw-YYYY.M.D.dSYM.zip`; include `.dmg` if available.

- Keep top version entries in `CHANGELOG.md` sorted by impact:
  - `### Changes` first.
  - `### Fixes` deduped and ranked with user-facing fixes first.
- Before tagging/publishing, run:
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `pnpm test:install:smoke` or `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` for non-root smoke path.
