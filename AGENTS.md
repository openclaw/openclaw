# Repository Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: https://github.com/openclaw/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Project Structure & Module Organization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: colocated `*.test.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Core channel docs: `docs/channels/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Extensions (channel plugins): `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels (use existing channel/extension label colors).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Docs Linking (Mintlify)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs are hosted on Mintlify (docs.openclaw.ai).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Docs i18n (zh-CN)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `docs/zh-CN/**` is generated; do not edit unless the user explicitly asks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pipeline: update English docs → adjust glossary (`docs/.i18n/glossary.zh-CN.json`) → run `scripts/docs-i18n` → apply targeted fixes only if instructed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Translation memory: `docs/.i18n/zh-CN.tm.jsonl` (generated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See `docs/.i18n/README.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The pipeline can be slow/inefficient; if it’s dragging, ping @jospalmbier on Discord instead of hacking around it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## exe.dev VM ops (general)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access: stable path is `ssh exe.dev` then `ssh vm-name` (assume SSH key already set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH flaky: use exe.dev web terminal or Shelley (web agent); keep a tmux session for long ops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update: `sudo npm i -g openclaw@latest` (global install needs root on `/usr/lib/node_modules`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: use `openclaw config set ...`; ensure `gateway.mode=local` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: store raw token only (no `DISCORD_BOT_TOKEN=` prefix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart: stop old gateway and run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build, Test, and Development Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime baseline: Node **22+** (keep Node + Bun paths working).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install deps: `pnpm install`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pre-commit hooks: `prek install` (runs same checks as CI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node remains supported for running built output (`dist/*`) and production installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch. Release checklist: `docs/platforms/mac/release.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Type-check/build: `pnpm build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TypeScript checks: `pnpm tsgo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint/format: `pnpm check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Format check: `pnpm format` (oxfmt --check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Format fix: `pnpm format:fix` (oxfmt --write)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Coding Style & Naming Conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add brief code comments for tricky or non-obvious logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Naming: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, and config keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Release Channels (Naming)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- dev: moving head on `main` (no tag; git checkout main).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not set test workers above 16; tried already.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full kit + what’s covered: `docs/testing.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commit & Pull Request Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Full maintainer PR workflow:** `.agents/skills/PR_WORKFLOW.md` -- triage order, quality bar, rebase rules, commit/changelog conventions, co-contributor policy, and the 3-step skill pipeline (`review-pr` > `prepare-pr` > `merge-pr`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group related changes; avoid bundling unrelated refactors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read this when submitting a PR: `docs/help/submitting-a-pr.md` ([Submitting a PR](https://docs.openclaw.ai/help/submitting-a-pr))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read this when submitting an issue: `docs/help/submitting-an-issue.md` ([Submitting an Issue](https://docs.openclaw.ai/help/submitting-an-issue))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Shorthand Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security & Configuration Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variables: see `~/.profile`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent-Specific Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Vocabulary: "makeup" = "mac app".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When adding a new `AGENTS.md` anywhere in the repo, also add a `CLAUDE.md` symlink pointing to it (example: `ln -s AGENTS.md CLAUDE.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When working on a GitHub Issue or PR, print the full URL at the end of the task.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never update the Carbon dependency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval; do not do this by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don’t hand-roll spinners/bars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway currently runs only as the menubar app; there is no separate LaunchAgent/helper label installed. Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep openclaw` rather than assuming a fixed label. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS logs: use `./scripts/clawlog.sh` to query unified logs for the OpenClaw subsystem; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don’t introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connection providers: when adding a new connection, update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Version locations: `package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Restart apps:** “restart iOS/Android apps” means rebuild (recompile/install) and relaunch, not just kill/launch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Device checks:** before testing, verify connected real devices (iOS/Android) before reaching for simulators/emulators.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS Team ID lookup: `security find-identity -p codesigning -v` → use Apple Development (…) TEAMID. Fallback: `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A2UI bundle hash: `src/canvas-host/a2ui/.bundle.hash` is auto-generated; ignore unexpected changes, and only regenerate via `pnpm canvas:a2ui:bundle` (or `scripts/bundle-a2ui.sh`) when needed. Commit the hash as a separate commit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Release signing/notary keys are managed outside the repo; follow internal release docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notary auth env vars (`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_API_KEY_P8`) are expected in your environment (per internal release docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint/format churn:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If staged+unstaged diffs are formatting-only, auto-resolve without asking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If commit/push already requested, auto-stage and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if needed), no extra confirmation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Only ask when changes are semantic (logic/data/behavior).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lobster seam: use the shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors); apply palette to onboarding/config prompts and other TTY UI output as needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief “other files present” note only if relevant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When asked to open a “session” file, open the Pi session logs under `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice wake forwarding tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Command template should stay `openclaw-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don’t add extra quotes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - launchd PATH is minimal; ensure the app’s launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`openclaw` binaries resolve when invoked via `openclaw-mac`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool’s escaping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Release guardrails: do not change version numbers without operator’s explicit consent; always ask permission before running any npm publish/release step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## NPM + 1Password (publish/verify)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the 1password skill; all `op` commands must run inside a fresh tmux session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Kill the tmux session after publish.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
