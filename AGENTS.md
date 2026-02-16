# OpenClaw Repository Guidelines

Repository: https://github.com/openclaw/openclaw

## Language Preference

- **Language:** Always respond in Chinese.

## Quick Reference: Build, Test, Lint

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- When working with documentation, read the mintlify skill.
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

# Development

pnpm dev # Run CLI in dev mode
pnpm openclaw <command> # Run specific CLI command

# Build & Type Checking

pnpm build # Full build (includes bundling, protocol gen, etc.)
pnpm tsgo # TypeScript type checking only

# Linting & Formatting

pnpm check # Run lint + format checks (run before commits)
pnpm lint # Oxlint only
pnpm format # Format with Oxfmt
pnpm lint:fix # Auto-fix lint issues and format

# Testing

pnpm test # Run all unit tests (vitest)
pnpm test:coverage # Run tests with coverage report
pnpm test:watch # Watch mode for development
pnpm test:e2e # End-to-end tests

# Run a single test file

pnpm vitest src/path/to/file.test.ts

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- If deps are missing (for example `node_modules` missing, `vitest not found`, or `command not found`), run the repo’s package-manager install command (prefer lockfile/README-defined PM), then rerun the exact requested command once. Apply this to test/build/lint/typecheck/dev commands; if retry still fails, report the command and first actionable error.
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

# Run a specific test by name

pnpm vitest -t "test name pattern"

# Mobile/Platform-Specific

pnpm ios:build # Build iOS app
pnpm android:run # Build and run Android app
pnpm mac:package # Package macOS app

````

## Project Structure

- **Source**: `src/` (CLI: `src/cli`, commands: `src/commands`, channels: `src/telegram`, `src/discord`, etc.)
- **Tests**: Colocated `*.test.ts` files next to source
- **Docs**: `docs/` (hosted on Mintlify at docs.openclaw.ai)
- **Build output**: `dist/`
- **Extensions/Plugins**: `extensions/*` (workspace packages)
- **Mobile apps**: `apps/ios`, `apps/android`, `apps/macos`

## Code Style & Conventions

### Language & Types
- **TypeScript ESM** with strict mode (`target: es2023`, `module: NodeNext`)
- **NO `any` types** - use proper typing (enforced by oxlint)
- Use `import type { X }` for type-only imports
- Prefer explicit types over inference for function signatures

### Imports
- **Use `.js` extensions** for cross-package imports (ESM requirement)
- **Import directly** - no re-export wrapper files
- **Import order**: sorted automatically by Oxfmt (no newlines between)
- Example: `import { foo } from "../infra/foo.js"`

### Formatting & Linting
- **Auto-formatted** by Oxfmt (4 spaces, double quotes, trailing commas)
- **Linted** by Oxlint with TypeScript-aware rules
- Run `pnpm check` before committing
- Curly braces required for all blocks (enforced)

### Naming Conventions
- **Product name**: "OpenClaw" (in docs, UI, headings)
- **CLI/binary**: `openclaw` (lowercase, in commands, paths, config keys)
- **Files**: kebab-case (e.g., `format-time.ts`, `agent-events.ts`)
- **Functions/variables**: camelCase
- **Types/Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE (for true constants)

### File Organization
- Keep files **under ~700 LOC** (guideline, not strict)
- Extract helpers instead of creating "V2" files
- Colocate tests: `foo.ts` → `foo.test.ts`
- E2E tests: `*.e2e.test.ts`

### Error Handling
- Use explicit error handling with try/catch
- Return `undefined` or result types instead of throwing when appropriate
- Validate inputs early (guard clauses)
- Log errors with context using `tslog`

### Comments
- Add **brief comments** for tricky or non-obvious logic
- Avoid redundant comments that just restate the code
- Document complex algorithms or business logic

## Anti-Redundancy Rules

**CRITICAL: Always reuse existing code - never duplicate!**

Before creating utilities, formatters, or helpers:
1. **Search for existing implementations first**
2. Import from the source of truth (see below)
3. Do NOT create local copies of utilities

### Source of Truth Locations

#### Formatting (`src/infra/format-time/`)
- **Time/duration**: `src/infra/format-time/format-duration.ts` (`formatDurationCompact`, `formatDurationHuman`, `formatDurationPrecise`)
- **Relative time**: `src/infra/format-time/format-relative.ts`
- **Date/time**: `src/infra/format-time/format-datetime.ts`

Never create local `formatAge`, `formatDuration`, `formatElapsedTime` - import from centralized modules.

#### Terminal Output (`src/terminal/`)
- **Tables**: `src/terminal/table.ts` (`renderTable`)
- **Themes/colors**: `src/terminal/theme.ts` (`theme.success`, `theme.muted`, etc.)
- **Progress/spinners**: `src/cli/progress.ts` (uses `osc-progress` + `@clack/prompts`)

#### CLI Patterns
- **Option wiring**: `src/cli/command-options.ts`
- **Commands**: `src/commands/`
- **Dependency injection**: via `createDefaultDeps`

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what’s covered: `docs/testing.md`.
- Changelog: user-facing changes only; no internal/meta notes (version alignment, appcast reminders, release process).
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

### Test Patterns
```typescript
import { describe, it, expect } from "vitest";

**Full maintainer PR workflow (optional):** If you want the repo's end-to-end maintainer workflow (triage order, quality bar, rebase rules, commit/changelog conventions, co-contributor policy, and the `review-pr` > `prepare-pr` > `merge-pr` pipeline), see `.agents/skills/PR_WORKFLOW.md`. Maintainers may use other workflows; when a maintainer specifies a workflow, follow that. If no workflow is specified, default to PR_WORKFLOW.

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PR submission template (canonical): `.github/pull_request_template.md`
- Issue submission templates (canonical): `.github/ISSUE_TEMPLATE/`

## Commit & PR Guidelines

- Use `scripts/committer "<msg>" <file...>` for commits (avoids staging issues)
- **Commit message style**: Concise, action-oriented (e.g., "CLI: add verbose flag to send")
- **Changelog**: Keep latest released version at top (no "Unreleased" section)
- **PR workflow**: Prefer rebase for clean history, squash when messy
- When working on PR: add changelog entry with PR # and thank contributor
- Run full gate before merging: `pnpm build && pnpm check && pnpm test`

## Git Notes

- If `git branch -d/-D <branch>` is policy-blocked, delete the local ref directly: `git update-ref -d refs/heads/<branch>`.

## Common Patterns

### CLI Progress
```typescript
import { createSpinner } from "../cli/progress.js";
const spinner = createSpinner("Loading...");
// ... work
spinner.stop("Done!");
````

### Dependency Injection

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

### Theme Colors

```typescript
import { theme } from "../terminal/theme.js";
console.log(theme.success("Success!"));
console.log(theme.error("Error!"));
```

## Channel/Extension Development

- Vocabulary: "makeup" = "mac app".
- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.
- When adding a new `AGENTS.md` anywhere in the repo, also add a `CLAUDE.md` symlink pointing to it (example: `ln -s AGENTS.md CLAUDE.md`).
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval; do not do this by default.
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don’t hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.
- Gateway currently runs only as the menubar app; there is no separate LaunchAgent/helper label installed. Restart via the OpenClaw Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep openclaw` rather than assuming a fixed label. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**
- macOS logs: use `./scripts/clawlog.sh` to query unified logs for the OpenClaw subsystem; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don’t introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.
- Connection providers: when adding a new connection, update every UI surface and docs (macOS app, web UI, mobile if applicable, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.
- Version locations: `package.json` (CLI), `apps/android/app/build.gradle.kts` (versionName/versionCode), `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion), `docs/install/updating.md` (pinned npm version), `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples), Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION).
- "Bump version everywhere" means all version locations above **except** `appcast.xml` (only touch appcast when cutting a new macOS Sparkle release).
- **Restart apps:** “restart iOS/Android apps” means rebuild (recompile/install) and relaunch, not just kill/launch.
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
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief “other files present” note only if relevant.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a “session” file, open the Pi session logs under `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
- Do not rebuild the macOS app over SSH; rebuilds must be run directly on the Mac.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- Voice wake forwarding tips:
  - Command template should stay `openclaw-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don’t add extra quotes.
  - launchd PATH is minimal; ensure the app’s launch agent PATH includes standard system paths plus your pnpm bin (typically `$HOME/Library/pnpm`) so `pnpm`/`openclaw` binaries resolve when invoked via `openclaw-mac`.
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool’s escaping.
- Release guardrails: do not change version numbers without operator’s explicit consent; always ask permission before running any npm publish/release step.

## Documentation

- **Docs hosted**: Mintlify (docs.openclaw.ai)
- **Internal links**: Root-relative without `.md` (e.g., `[Config](/configuration)`)
- **Anchors**: Root-relative with hash (e.g., `[Hooks](/configuration#hooks)`)
- **No em dashes or apostrophes** in headings (breaks Mintlify anchors)
- Use generic placeholders (no personal device names/paths)

## Platform-Specific Notes

### macOS

- Gateway runs as menubar app (restart via app or `scripts/restart-mac.sh`)
- Logs: `./scripts/clawlog.sh` for unified logs
- Packaging: `scripts/package-mac-app.sh`

### iOS/Android

- Check for connected real devices before using simulators
- "Restart app" means rebuild and relaunch (not just kill/reopen)

## Security

- Never commit real credentials, phone numbers, or config values
- Use fake/placeholder values in docs and tests
- Web provider creds: `~/.openclaw/credentials/`
- Pi sessions: `~/.openclaw/sessions/`

## Multi-Agent Safety

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
  - per-plugin: `npm view @openclaw/<name> version --userconfig "$(mktemp)"` should be `2026.2.16`
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
