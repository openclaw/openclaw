# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

- https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Architecture Overview

OpenClaw is a multi-platform AI assistant gateway that bridges messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage) to AI backends. The architecture consists of:

- **Gateway (daemon)**: Long-lived process that owns all messaging surfaces and exposes a WebSocket API on `127.0.0.1:18789`. Validates frames against JSON Schema, emits events (`agent`, `chat`, `presence`, `health`).
- **Clients**: macOS app, CLI, web UI connect via WebSocket to send requests and subscribe to events.
- **Nodes**: macOS/iOS/Android devices connect with `role: node` to provide device capabilities (camera, screen, location).
- **Agents**: AI-powered assistants using Pi agent-core, with tool execution, bash process management, and context compaction.
- **Canvas Host**: Serves agent-editable HTML/A2UI on port 18793.

Protocol: TypeBox schemas → JSON Schema → Swift models (codegen).

## Project Structure

- `src/` — Core TypeScript source
  - `src/cli/` — CLI wiring, commands use Commander
  - `src/commands/` — Command implementations
  - `src/agents/` — Agent loop, tools, auth profiles, context management
  - `src/gateway/` — WebSocket server, protocol handling
  - `src/channels/`, `src/routing/` — Channel abstraction and message routing
  - `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/` — Built-in channel implementations
  - `src/infra/` — Utilities (binaries, ports, env, errors)
  - `src/media/` — Media pipeline
  - `src/plugin-sdk/` — Plugin SDK exports
- `apps/` — Native apps: `macos/`, `ios/`, `android/`, `shared/` (OpenClawKit)
- `extensions/` — Channel plugins (workspace packages): msteams, matrix, zalo, voice-call, etc.
- `docs/` — Mintlify documentation (hosted at docs.openclaw.ai)
- `dist/` — Build output
- `skills/` — Bundled skill definitions

Tests are colocated as `*.test.ts`; e2e tests use `*.e2e.test.ts`.

### Plugins/Extensions

- Live under `extensions/*` as workspace packages.
- Keep plugin-only deps in the extension `package.json`, not root.
- Runtime deps must be in `dependencies`. Avoid `workspace:*` in `dependencies` (breaks npm install); put `openclaw` in `devDependencies` or `peerDependencies`.
- Installers served from `https://openclaw.ai/*` live in sibling repo `../openclaw.ai`.

### Messaging Channels

Always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs). Review `.github/labeler.yml` for label coverage when adding channels.

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

## Docs i18n (zh-CN)

- `docs/zh-CN/**` is generated; do not edit unless the user explicitly asks.
- Pipeline: update English docs → adjust glossary (`docs/.i18n/glossary.zh-CN.json`) → run `scripts/docs-i18n` → apply targeted fixes only if instructed.
- Translation memory: `docs/.i18n/zh-CN.tm.jsonl` (generated).
- See `docs/.i18n/README.md`.
- The pipeline can be slow/inefficient; if it’s dragging, ping @jospalmbier on Discord instead of hacking around it.

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

### Setup

```bash
pnpm install              # Install dependencies
prek install              # Pre-commit hooks (same checks as CI)
```

Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync).

### Development

```bash
pnpm openclaw ...         # Run CLI in dev mode (uses Bun)
pnpm dev                  # Alternative dev entry
pnpm gateway:dev          # Run gateway in dev (skips channels)
bun <file.ts>             # Prefer Bun for TypeScript execution
```

### Build & Lint

```bash
pnpm build                # Type-check and build to dist/
pnpm check                # Run tsgo + lint + format checks
pnpm lint:fix             # Auto-fix lint issues
```

### Testing

```bash
pnpm test                 # Run all tests (vitest, parallel)
pnpm test:coverage        # Run with V8 coverage
pnpm test:watch           # Watch mode
vitest run src/foo.test.ts           # Run single test file
vitest run -t "test name"            # Run tests matching name
CLAWDBOT_LIVE_TEST=1 pnpm test:live  # Live tests with real keys
pnpm test:e2e             # E2E tests
pnpm test:docker:all      # All Docker-based tests
```

### Platform-Specific

```bash
scripts/package-mac-app.sh           # Mac packaging (current arch)
pnpm ios:run                         # Build and run iOS app
pnpm android:run                     # Build and run Android app
```

### Runtime Requirements

- Node **22+** (keep Node + Bun paths working)
- Node for built output (`dist/*`) and production installs
- Mac packaging release checklist: `docs/platforms/mac/release.md`

## Coding Style

- **Language**: TypeScript (ESM). Prefer strict typing; avoid `any`.
- **Linting/Format**: Oxlint + Oxfmt. Run `pnpm check` before commits.
- **File size**: Aim for ~500-700 LOC max; split/refactor when it improves clarity.
- **Comments**: Add brief comments for tricky logic only.
- **Patterns**: Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- **Naming**: **OpenClaw** for product/docs headings; `openclaw` for CLI, package, paths, config keys.
- **CLI progress**: Use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner).
- **Tables/output**: Use `src/terminal/table.ts` for ANSI-safe wrapping.
- **Colors**: Use shared palette in `src/terminal/palette.ts` (no hardcoded colors).
- **Tool schemas**: Avoid `Type.Union`, `anyOf/oneOf/allOf`. Use `stringEnum`/`optionalStringEnum` for string lists.

## Release Channels (Naming)

- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).
- dev: moving head on `main` (no tag; git checkout main).

## Testing Guidelines

- **Framework**: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- **Naming**: `*.test.ts` colocated with source; `*.e2e.test.ts` for e2e.
- **Workers**: Do not set above 16.
- **Mobile**: Prefer connected real devices over simulators when available.
- **Changelog**: Pure test additions/fixes do not need changelog entries unless they alter user-facing behavior.
- Full testing guide: `docs/testing.md`.

## Commit & Pull Request Guidelines

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Changelog workflow: keep latest released version at top (no `Unreleased`); after publishing, bump version and start a new top section.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.
- PR review flow: when given a PR link, review via `gh pr view`/`gh pr diff` and do **not** change branches.
- PR review calls: prefer a single `gh pr view --json ...` to batch metadata/comments; run `gh pr diff` only when needed.
- Before starting a review when a GH Issue/PR is pasted: run `git pull`; if there are local changes or unpushed commits, stop and alert the user before reviewing.
- Goal: merge PRs. Prefer **rebase** when commits are clean; **squash** when history is messy.
- PR merge flow: create a temp branch from `main`, merge the PR branch into it (prefer squash unless commit history is important; use rebase/merge when it is). Always try to merge the PR unless it’s truly difficult, then use another approach. If we squash, add the PR author as a co-contributor. Apply fixes, add changelog entry (include PR # + thanks), run full gate before the final commit, commit, merge back to `main`, delete the temp branch, and end on `main`.
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.
- When working on a PR: add a changelog entry with the PR number and thank the contributor.
- When working on an issue: reference the issue in the changelog entry.
- When merging a PR: leave a PR comment that explains exactly what we did and include the SHA hashes.
- When merging a PR from a new contributor: add their avatar to the README “Thanks to all clawtributors” thumbnail list.
- After merging a PR: run `bun scripts/update-clawtributors.ts` if the contributor is missing, then commit the regenerated README.

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

### PR Workflow (Review vs Land)

- **Review mode (PR link only):** read `gh pr view/diff`; **do not** switch branches; **do not** change code.
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!

## Security & Configuration Tips

- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.

## Troubleshooting

- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).

## Agent-Specific Notes

### Vocabulary & Conventions

- "makeup" = "mac app"
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- Respond with high-confidence answers only: verify in code; do not guess.

### Dependencies

- Never edit `node_modules` (global/Homebrew/npm/git installs too).
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies requires explicit approval; do not do this by default.

### macOS/iOS Development

- Gateway runs only as the menubar app; no separate LaunchAgent. Restart via OpenClaw Mac app or `scripts/restart-mac.sh`.
- macOS logs: use `./scripts/clawlog.sh` to query unified logs.
- SwiftUI: prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`.
- iOS Team ID: `security find-identity -p codesigning -v` → use TEAMID from Apple Development cert.
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.
- "restart iOS/Android apps" means rebuild (recompile/install) and relaunch, not just kill/launch.

### Version Locations

- `package.json` (CLI)
- `apps/android/app/build.gradle.kts` (versionName/versionCode)
- `apps/ios/Sources/Info.plist` (CFBundleShortVersionString/CFBundleVersion)
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md` (pinned npm version)

### Multi-Agent Safety

- Do **not** create/apply/drop `git stash` entries unless explicitly requested.
- Do **not** create/remove/modify `git worktree` checkouts unless explicitly requested.
- Do **not** switch branches unless explicitly requested.
- When "push": may `git pull --rebase` (never discard others' work). When "commit": scope to your changes only.
- When you see unrecognized files, keep going; focus on your changes.
- Focus reports on your edits; end with brief "other files present" note only if relevant.

### Lint/Format Churn

- If staged+unstaged diffs are formatting-only, auto-resolve without asking.
- If commit/push already requested, auto-stage formatting follow-ups in same commit.
- Only ask when changes are semantic (logic/data/behavior).

### Release

- Release guardrails: do not change version numbers without explicit consent; always ask permission before npm publish/release.
- A2UI bundle hash (`src/canvas-host/a2ui/.bundle.hash`) is auto-generated; only regenerate via `pnpm canvas:a2ui:bundle`.
- Notary auth env vars expected: `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_API_KEY_P8`.

### Messaging

- Never send streaming/partial replies to external surfaces (WhatsApp, Telegram); only final replies.
- For `openclaw message send` with `!`, use heredoc pattern to avoid Bash escaping.

## NPM + 1Password (publish/verify)

- Use the 1password skill; all `op` commands must run inside a fresh tmux session.
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publish.
