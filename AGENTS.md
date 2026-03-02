# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- In chat replies, file references must be repo-root relative only (example: `extensions/bluebubbles/src/channel.ts:80`); never absolute paths or `~/...`.
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
- GitHub comment footgun: never use `gh issue/pr comment -b "..."` when body contains backticks or shell chars. Always use single-quoted heredoc (`-F - <<'EOF'`) so no command substitution/escaping corruption.
- Security advisory analysis: before triage/severity decisions, read `SECURITY.md` to align with OpenClaw's trust model and design boundaries.

## Project Structure

- Source: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, infra in `src/infra`, media pipeline in `src/media`)
- Tests: colocated `*.test.ts`
- Docs: `docs/` — built output in `dist/`
- Plugins/extensions: `extensions/*` (workspace packages). Plugin-only deps stay in the extension `package.json`; avoid `workspace:*` in `dependencies`.
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic.
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web`, `src/channels`, `src/routing`
  - Extension channels: `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`)
- When adding channels/extensions/apps/docs, update `.github/labeler.yml` and create matching GitHub labels.

## Key Docs

| Path                            | Purpose                                    |
| ------------------------------- | ------------------------------------------ |
| `docs/decisions/`               | ADRs — read before changing covered areas  |
| `docs/conventions.md`           | Coding style, naming, TypeScript rules     |
| `docs/testing.md`               | Testing setup, commands, live tests        |
| `docs/releases.md`              | Release channels, versioning, publish flow |
| `docs/ops/vm.md`                | exe.dev VM ops and SSH access              |
| `docs/reference/RELEASING.md`   | Full release checklist                     |
| `.agents/skills/PR_WORKFLOW.md` | Maintainer PR workflow                     |

## Architecture Decisions

See `docs/decisions/` for ADRs. Read the relevant ADR before changing an area it covers.

## Build & Test Commands

```bash
pnpm install       # Install deps
pnpm build         # Type-check/build
pnpm tsgo          # TypeScript checks
pnpm check         # Lint/format (Oxlint + Oxfmt)
pnpm format:fix    # Format fix
pnpm test          # Run tests (Vitest)
pnpm test:coverage # With V8 coverage
```

- Runtime baseline: Node **22+**
- Prefer Bun for TypeScript execution: `bun <file.ts>` / `bunx <tool>`
- Low-memory test run: `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`
- Pre-commit hooks: `prek install`
- See `docs/testing.md` for full test suite details.

## Commit & PR Guidelines

- Create commits with `scripts/committer "<msg>" <file...>`
- Follow Conventional Commit style (e.g. `CLI: add verbose flag to send`)
- PR template: `.github/pull_request_template.md`
- Full maintainer workflow: `.agents/skills/PR_WORKFLOW.md`

## Docs (Mintlify)

- Internal links: root-relative, no `.md`/`.mdx` extension (e.g. `[Config](/configuration)`)
- Docs content must be generic: no personal device names/hostnames/paths
- `docs/zh-CN/**` is generated; do not edit unless explicitly asked
- See `docs/.i18n/README.md` for i18n pipeline

## Security & Configuration

- Never commit real phone numbers, videos, or live config values — use obvious placeholders
- Release flow: read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work
- See `docs/releases.md` for version locations and release channel conventions

## Agent-Specific Notes

- When adding a new `AGENTS.md` anywhere, also add a `CLAUDE.md` symlink: `ln -s AGENTS.md CLAUDE.md`
- Vocabulary: "makeup" = "mac app"
- Never edit `node_modules`. Never update Carbon dependency.
- Any dep with `pnpm.patchedDependencies` must use exact version (no `^`/`~`)
- CLI progress: use `src/terminal/palette.ts` and `src/cli/progress.ts`
- SwiftUI: prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`
- Version locations: `package.json`, `apps/android/app/build.gradle.kts`, `apps/ios/Sources/Info.plist`, `apps/macos/Sources/OpenClaw/Resources/Info.plist` — "bump version everywhere" means all of these
- Bug investigations: read source + relevant npm deps before concluding; aim for high-confidence root cause
- When asked to open a "session" file: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Do not rebuild the macOS app over SSH

## Multi-Agent Safety

- Do **not** create/apply/drop `git stash` entries unless explicitly requested
- Do **not** create/remove/modify `git worktree` checkouts unless explicitly requested
- Do **not** switch branches unless explicitly requested
- When "push" is requested: `git pull --rebase` first to integrate latest changes
- When "commit" is requested: scope to your changes only; "commit all" = commit in grouped chunks
- When you see unrecognized files, keep going; focus on your changes

## Shorthand Commands

- `sync`: commit all dirty changes (sensible Conventional Commit message), `git pull --rebase`, `git push`

## Knowledge Capture

After completing any non-trivial work (took multiple attempts, non-obvious solution, future sessions would benefit), capture the solution in `docs/solutions/`.

Note: `/ce:compound` integration is pending skill access setup — see `docs/decisions/` for tracking note. In the meantime, write solutions manually to `docs/solutions/[category]/filename.md`.

## Doc Gardening

A doc-gardening agent runs periodically to check for drift between docs and code and opens fix PRs. Do not try to do this manually.
