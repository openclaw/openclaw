# Repository Guidelines

- Repo: https://github.com/Interstellar-code/operator1
- Upstream (read-only): https://github.com/openclaw/openclaw
- In chat replies, file references must be repo-root relative only (example: `src/gateway/server-methods.ts:80`); never absolute paths or `~/...`.
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
- GitHub comment footgun: never use `gh issue/pr comment -b "..."` when body contains backticks or shell chars. Always use single-quoted heredoc (`-F - <<'EOF'`) so no command substitution/escaping corruption.
- GitHub linking footgun: don't wrap issue/PR refs like `#123` in backticks when you want auto-linking. Use plain `#123` (optionally add full URL).
- GitHub searching footgun: don't limit yourself to the first 500 issues or PRs when wanting to search all. Unless you're supposed to look at the most recent, keep going until you've reached the last page in the search.

## Project Structure & Module Organization

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`, gateway in `src/gateway`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/`. Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Agent workspaces: `workspaces/` (operator1, neo, morpheus, trinity). Each has `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `MEMORY.md`, and a `memory/` directory for daily notes.
- Skills: `.claude/skills/` (Claude Code skills), `skills/` (gateway runtime skills).
- Agents: `.claude/agents/` (Claude Code agent definitions).
- UI: `ui-next/` (control UI, part of root pnpm workspace). Build: `cd ui-next && pnpm build` (serves from `dist/control-ui-next/`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- If deps are missing (for example `node_modules` missing, `vitest not found`, or `command not found`), run `pnpm install`, then rerun the exact requested command once. If retry still fails, report the command and first actionable error.
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` or `pnpm dev`.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Format check: `pnpm format` (oxfmt --check)
- Format fix: `pnpm format:fix` (oxfmt --write)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`
- For targeted/local debugging: `pnpm test -- <path-or-filter> [vitest args...]`; do not default to raw `pnpm vitest run ...` because it bypasses wrapper config/profile/pool routing.
- UI build: `cd ui-next && pnpm build`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Never add `@ts-nocheck` and do not disable `no-explicit-any`; fix root causes.
- Dynamic import guardrail: do not mix `await import("x")` and static `import ... from "x"` for the same module in production code paths. If you need lazy loading, create a dedicated `*.runtime.ts` boundary.
- Never share class behavior via prototype mutation. Use explicit inheritance/composition.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; aim for under ~500 LOC when feasible (split/refactor as needed).
- Written English: use American spelling and grammar in code, comments, docs, and UI strings.
- Tool schema guardrails: avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` for string lists, and `Type.Optional(...)` instead of `... | null`.

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Write tests to clean up timers, env, globals, mocks, sockets, temp dirs, and module state so `--isolate=false` stays green.
- Agents MUST NOT modify baseline, inventory, ignore, snapshot, or expected-failure files to silence failing checks without explicit approval in this chat.
- For targeted/local debugging, keep using the wrapper: `pnpm test -- <path-or-filter> [vitest args...]` (for example `pnpm test -- src/commands/onboard-search.test.ts -t "shows registered plugin providers"`); do not default to raw `pnpm vitest run ...` because it bypasses wrapper config/profile/pool routing.
- Do not set test workers above 16; tried already.
- Do not reintroduce Vitest VM pools by default without fresh green evidence on current `main`; keep CI on `forks`.
- If local Vitest runs cause memory pressure (common on non-Mac-Studio hosts), use `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test` for land/gate runs.
- Live tests (real keys): `OPENCLAW_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what’s covered: `docs/help/testing.md`.
- Changelog: user-facing changes only; no internal/meta notes (version alignment, appcast reminders, release process).
- Changelog placement: in the active version block, append new entries to the end of the target section (`### Changes` or `### Fixes`); do not insert new entries at the top of a section.
- Changelog attribution: use at most one contributor mention per line; prefer `Thanks @author` and do not also add `by @author` on the same entry.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

## Commit & Pull Request Guidelines

- Never push directly to main. Always use feature branches + PRs.
- Follow concise, action-oriented commit messages (e.g., `fix(gateway): correct session routing for cron messages`).
- Group related changes; avoid bundling unrelated refactors.

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

## Git Notes

- If `git branch -d/-D <branch>` is policy-blocked, delete the local ref directly: `git update-ref -d refs/heads/<branch>`.

## GitHub Search (`gh`)

- Prefer targeted keyword search before proposing new work or duplicating fixes.
- Use `--repo Interstellar-code/operator1` + `--match title,body` first; add `--match comments` when triaging follow-up threads.
- PRs: `gh search prs --repo Interstellar-code/operator1 --match title,body --limit 50 -- "keyword"`
- Issues: `gh search issues --repo Interstellar-code/operator1 --match title,body --limit 50 -- "keyword"`

## Security & Configuration Tips

- Credentials stored at `~/.openclaw/credentials/`.
- Agent sessions live under `~/.openclaw/agents/<agentId>/sessions/*.jsonl`.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.

## Gateway Operations

- Gateway runs as a LaunchAgent (`ai.openclaw.gateway`), NOT the Mac app.
- Restart: `pnpm build` then `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.
- If service is unloaded: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist`.
- Do NOT use `pkill` to restart the gateway.
- All state is in SQLite (`operator1.db`, schema v10+). New state goes into `core_settings(scope, key, value_json)` or a dedicated table. Never create new JSON files under `~/.openclaw/`.
- When asked to open a "session" file, open the agent session logs at `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (newest unless a specific ID is given).

## Upstream Sync

- Upstream (OpenClaw) is a read-only remote. Sync via the `upstream-sync` skill.
- After merging upstream, always verify these "append-only registry" files:
  1. `src/gateway/server-methods.ts` — every `server-methods/*.ts` handler imported AND spread into `coreGatewayHandlers`
  2. `src/gateway/server-methods-list.ts` — every method name in `BASE_METHODS`
  3. `src/gateway/method-scopes.ts` — every method has a scope entry (unclassified = default-denied)
  4. `package.json` `exports` — all `./plugin-sdk/*` subpath exports present (missing = all extensions fail)
- Build passing does not mean runtime correct. Check SQLite vs JSON storage divergence after syncs. Always smoke-test `sessions.list` RPC.

## Agent-Specific Notes

- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval.
- Never edit `node_modules`. Updates overwrite.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When adding a new `AGENTS.md` anywhere in the repo, also add a `CLAUDE.md` symlink pointing to it.
- Never delete `IDENTITY.md` from workspaces; the system reads it for identity resolution.
- Do not restrict main agent tool profile; use prompt-based delegation instead of config restrictions.
- Web content extraction: when using WebFetch on web pages (articles, docs, blog posts, READMEs), prefix URLs with `https://r.jina.ai/` for clean markdown instead of raw HTML (~90% fewer tokens, no API key needed). Example: `https://r.jina.ai/https://example.com/article`. Do NOT use for APIs, JSON endpoints, raw file downloads, or GitHub API calls.

## Multi-Agent Safety

- Do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working.
- When the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- Do **not** create/remove/modify `git worktree` checkouts unless explicitly requested.
- Do **not** switch branches / check out a different branch unless explicitly requested.
- Running multiple agents is OK as long as each agent has its own session.
- When you see unrecognized files, keep going; focus on your changes and commit only those.
- Focus reports on your edits; avoid guard-rail disclaimers unless truly blocked.

## Lint/Format Churn

- If staged+unstaged diffs are formatting-only, auto-resolve without asking.
- If commit/push already requested, auto-stage and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if needed), no extra confirmation.
- Only ask when changes are semantic (logic/data/behavior).
