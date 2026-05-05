# CLAUDE.md / AGENTS.md

Dev rules and pointers for working in `openclaw/openclaw`. Read once at session start.

This file is the entrypoint. Four companion docs hold the rest:
- `CHARTER.md` — public contracts, boundary rules, compatibility commitments
- `CHITTY.md` — repo map, stack, channel/provider topology, consumers
- `OPS.md` — apps/platform, gateway watch, version bumps, mobile pairing, footguns
- `SECURITY.md` — trust model, vulnerability reporting, restricted surfaces

OpenClaw is a personal AI assistant gateway. See `CHITTY.md` for what it is, how it's built, and where the code lives.

## Quick reference

```bash
pnpm install                          # (also: bun install)
pnpm check                            # lint + typecheck (local dev gate)
pnpm test                             # full test suite (vitest)
pnpm test src/foo.test.ts             # single test file
pnpm test src/foo.test.ts -t "name"   # single test by name
pnpm build                            # production build (tsdown → dist/)
pnpm dev                              # run CLI in dev mode
pnpm format:fix                       # auto-fix formatting (oxfmt)
pnpm tsgo                             # TS checks
```

Prefer Bun for TS execution (`bun <file.ts>`). Node 22+ for built output.

Commits: `scripts/committer "<msg>" <file...>` (avoid manual `git add` / `git commit` so staging stays scoped).

## Output rules (replies in this chat)

- File references must be repo-root relative (example: `src/telegram/index.ts:80`). Never absolute paths or `~/...`.
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`). Section anchors on root-relative paths (`[Hooks](/configuration#hooks)`).
- Doc headings/anchors: avoid em dashes and apostrophes (they break Mintlify anchors).
- When the user asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative). End the reply with the URLs you referenced.
- README (GitHub): keep absolute docs URLs so links work on GitHub.
- For docs / UI copy / picker lists, order services/providers alphabetically — unless the section explicitly describes runtime behavior (e.g. auto-detection or execution order).
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- High-confidence answers only — verify in code, don't guess.
- Bug investigations: read source of relevant npm deps and all related local code before concluding; aim for high-confidence root cause.
- Docs content stays generic: no personal device names/hostnames/paths. Use placeholders (`user@gateway-host`, "gateway host").
- Written English: American spelling ("color", "behavior", "analyze").

## Code style

- TypeScript (ESM). Strict typing — avoid `any`. Don't disable `no-explicit-any`; use real types, `unknown`, or a narrow adapter.
- Never add `@ts-nocheck` or inline lint suppressions by default. Fix root causes; only keep a suppression when the code is intentionally correct, the rule can't express that safely, and the comment explains why.
- Prefer `zod` (or existing schema helpers) at external boundaries: config, webhook payloads, CLI/JSON output, persisted JSON, third-party API responses.
- Prefer discriminated unions when parameter shape changes runtime behavior.
- Prefer `Result<T, E>`-style outcomes and closed error-code unions for recoverable runtime decisions.
- Keep human-readable strings for logs/CLI/UI; don't use freeform strings as the source of truth for internal branching. New runtime control-flow code should not branch on `error: string` or `reason: string` when a closed code union would do.
- Avoid `?? 0`, empty-string, empty-object, or magic-string sentinels when they can change runtime meaning silently.
- New optional/nullable field in core logic that changes behavior → prefer an explicit union or dedicated type.
- Never share class behavior via prototype mutation. Use explicit inheritance/composition (`A extends B extends C`) so TS can typecheck. If prototype mutation seems needed, stop and get explicit approval first.
- In tests, prefer per-instance stubs over prototype mutation unless a test explicitly documents why.
- Brief code comments for tricky/non-obvious logic.
- Keep files focused. Aim under ~700 LOC; split/refactor when it improves clarity or testability.
- Naming: **OpenClaw** for product/app/docs headings; `openclaw` for CLI command, package/binary, paths, config keys. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.

### Dynamic-import guardrail

- Don't mix `await import("x")` and static `import ... from "x"` for the same module in production paths. For lazy loading, create a dedicated `*.runtime.ts` boundary (re-exports from `x`) and dynamically import that boundary from lazy callers.
- After refactors touching lazy-loading/module boundaries, run `pnpm build` and check for `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings before submitting.

### Import-boundary cheat sheet

Full rules in `CHARTER.md`. Quick version:
- Extension production code → only `openclaw/plugin-sdk/*` + local `./api.ts` / `./runtime-api.ts`. No `src/**`, no `src/plugin-sdk-internal/**`, no other extension's `src/**`.
- Inside an extension, don't import yourself via `openclaw/plugin-sdk/<self>` — use the local barrel.
- Inside a bundled plugin package, no relative imports/exports that escape the package root.
- Core code never deep-imports bundled plugin internals; reach via the plugin's `api.ts` or `src/plugin-sdk/<id>.ts`.

## Testing

- Vitest. V8 coverage thresholds 70% (lines/branches/functions/statements).
- Naming: `*.test.ts` matching source name; e2e in `*.e2e.test.ts`.
- Default model constants for examples: `sonnet-4.6`, `gpt-5.5` (5.4 also acceptable). No GPT-4.x agent-smoke defaults. Update older Anthropic/GPT examples when you touch those tests.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Tests must clean up timers, env, globals, mocks, sockets, temp dirs, and module state — `--isolate=false` stays green.
- For targeted/local debugging use `pnpm test <path-or-filter> [vitest args...]`. Don't drop to raw `pnpm vitest run ...` (bypasses the repo's default config/profile/pool routing).
- Don't set test workers above 16. If memory pressure, use `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`.
- Pool default: native root-project `threads`, with hard `forks` exceptions for `gateway`, `agents`, `commands`. Use `OPENCLAW_VITEST_POOL=forks` for full local fork debugging.
- Live tests: `OPENCLAW_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (incl. provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`, `pnpm test:docker:onboard`. Quiet by default; `OPENCLAW_LIVE_TEST_QUIET=0 pnpm test:live` for full logs.
- Test performance: don't reset modules + re-`import()` per-test for heavy modules. Static-import once in `beforeAll`, reset/prime mocks in `beforeEach`. Don't partial-mock broad `openclaw/plugin-sdk/*` barrels in hot tests — add a plugin-local `*.runtime.ts` seam and mock that. When production code accepts `deps`/callbacks/runtime injection, use that seam in tests before adding module-level mocks. Treat import-dominated test time as a boundary bug; fix the import surface before adding cases. Full kit: `docs/help/testing.md`.
- Agents MUST NOT modify baseline/inventory/ignore/snapshot/expected-failure files to silence failing checks without explicit approval in this chat.

## Workflow

### Verification gates

- "gate" = a verification command set that must be green for the decision you're making.
- **Local dev gate:** `pnpm check` plus any scoped test you actually need.
- **Landing gate (push to `main`):** `pnpm check` + `pnpm test`. Add `pnpm build` if the change can affect build output, packaging, lazy-loading/module boundaries, or published surfaces (hard gate).
- **CI gate:** whatever the relevant workflow enforces (`check`, `check-additional`, `build-smoke`, release validation). `check-additional` is the architecture/boundary policy gate, intentionally kept out of the local loop.

### Pre-commit / formatting

- Pre-commit hooks: `prek install`. The hook runs `pnpm format` then `pnpm check`.
- `FAST_COMMIT=1 git commit ...` skips the hook's repo-wide `pnpm format` and `pnpm check`. Use only when you're deliberately covering the touched surface another way; doesn't change CI.
- Formatting-only diffs: auto-resolve in commit/push without asking. Only ask when changes are semantic.

### Modes for `main`

- **Default:** `main` is stable. Trust pre-commit hook coverage, avoid ceremony reruns, keep CI green before landing. Favor `pnpm check` + `pnpm test` near the final rebase/push when feasible.
- **Fast-commit:** `main` is moving fast. Prefer explicit local verification close to the final landing point; `--no-verify` is acceptable for intermediate/catch-up commits after equivalent checks ran locally. Verification sequencing changes; the requirement to validate the touched surface before final landing does not.

### Scoped vs full tests

- Scoped tests prove the change. `pnpm test` remains the default `main` landing bar.
- Don't use scoped tests as permission to ignore plausibly related failures.
- For narrowly scoped changes, prefer narrowly scoped tests. If no meaningful scoped test exists, say so explicitly and use the next most direct validation.
- Don't land changes with failing format/lint/type/build/required-test checks caused by or plausibly related to the change.
- If unrelated failures already exist on latest `origin/main`, state that clearly, report scoped tests run, and ask before broadening scope or landing despite them.

### Drift checks

- Generated baselines under `docs/.generated/` use SHA-256 hash files (`.sha256` tracked, full JSON gitignored).
- Config schema drift: `pnpm config:docs:gen` / `pnpm config:docs:check`.
- Plugin SDK API drift: `pnpm plugin-sdk:api:gen` / `pnpm plugin-sdk:api:check`.
- If you change config schema/help or the public Plugin SDK surface, run the matching gen command and commit the updated `.sha256` hash file.

### Local-shell host-aware checks

- Local agent/dev shells default to `OPENCLAW_LOCAL_CHECK=1` for `pnpm tsgo` and `pnpm lint`.
- `OPENCLAW_LOCAL_CHECK_MODE=throttled` → lower-memory profile.
- `OPENCLAW_LOCAL_CHECK_MODE=full` → lock-only behavior.
- `OPENCLAW_LOCAL_CHECK=0` → CI/shared runs.

### Missing deps

- If deps are missing (`node_modules` missing, `vitest not found`, `command not found`), run the repo's package-manager install command (prefer lockfile/README-defined PM), then rerun the requested command once. Apply to test/build/lint/typecheck/dev. If retry fails, report the command and first actionable error.

### Commits / PRs

- `scripts/committer "<msg>" <file...>` — concise, action-oriented messages (`CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PR template: `.github/pull_request_template.md`. Issue templates: `.github/ISSUE_TEMPLATE/`.
- `/landpr` (in `~/.codex/prompts/landpr.md`) is the canonical landing flow; follow it when landing/merging any PR.

### Multi-agent safety

- Don't create/apply/drop `git stash` (incl. `git pull --rebase --autostash`) unless asked. Don't switch branches. Don't touch `git worktree` checkouts (`.worktrees/*`).
- "push" → may `git pull --rebase` to integrate latest (never discard others' work). "commit" → scope to your changes. "commit all" → commit everything in grouped chunks.
- Prefer grouped `commit` / `pull --rebase` / `push` cycles for related work over many tiny syncs.
- Multiple agents per file is fine; focus reports on your edits, brief "other files present" note only if relevant.
- Bulk PR close/reopen: action affecting >5 PRs requires explicit user confirmation with exact PR count + scope/query.
- Agents MUST NOT create or push merge commits on `main` — rebase onto latest `origin/main` first.
- If `git branch -d/-D` is policy-blocked, delete the local ref directly: `git update-ref -d refs/heads/<branch>`.

### Changelog

- User-facing changes only. No internal/meta notes (version alignment, appcast reminders, release process).
- Append new entries to the END of the target section in the active version block (`### Changes` or `### Fixes`); don't insert at the top.
- At most one contributor mention per line — prefer `Thanks @author`, don't double up with `by @author`.
- Pure test additions/fixes: no changelog entry unless they alter user-facing behavior or the user asks.

## Doc pipelines

- **Mintlify (English):** read the `mintlify` skill when working with documentation.
- **Foreign-language docs:** generated, not maintained here. Source of truth = English docs + `docs/.i18n/glossary.<locale>.json`. Pipeline updates `openclaw/docs` (sibling `openclaw-docs/`). Before rerunning `scripts/docs-i18n`, add glossary entries for new technical terms / page titles / short nav labels that must stay English or use a fixed translation. `pnpm docs:check-i18n-glossary` enforces glossary coverage. Pipeline can be slow; if dragging, ping @jospalmbier on Discord. See `docs/.i18n/README.md`.
- **Control UI i18n (in this repo):** source of truth = `ui/src/i18n/locales/en.ts` + generator/runtime wiring (`scripts/control-ui-i18n.ts`, `ui/src/i18n/lib/types.ts`, `ui/src/i18n/lib/registry.ts`). Update English + run `pnpm ui:i18n:sync` (or let `Control UI Locale Refresh` do it) → commit regenerated locale bundles + `.i18n` metadata. Don't hand-edit `ui/src/i18n/locales/*.ts` for non-English locales or `ui/src/i18n/.i18n/*` unless a targeted generated-output fix is requested.

## Pointers (tasks → where to look)

| Task | Where |
|---|---|
| Public contracts / boundary rules | `CHARTER.md` |
| Architecture, repo layout, channels, consumers | `CHITTY.md` |
| Per-package boundary detail | `<package>/AGENTS.md` (linked in `CHITTY.md`) |
| Trust model, vuln reporting, restricted surfaces, release auth | `SECURITY.md` |
| Apps/platform, Mac gateway, version bumps, mobile pairing, footguns | `OPS.md` |
| GitHub/CI wait matrix, Testbox/Blacksmith routing, changed-lane gates | `OPS.md` |
| Release / changelog / version coordination | `$openclaw-release-maintainer` (`.agents/skills/openclaw-release-maintainer/SKILL.md`) |
| GHSA advisory flow | `$openclaw-ghsa-maintainer` (`.agents/skills/openclaw-ghsa-maintainer/SKILL.md`) |
| PR triage / review / land / search | `$openclaw-pr-maintainer` (`.agents/skills/openclaw-pr-maintainer/SKILL.md`) |
| Parallels smoke (macOS/Win/Linux guests) | `$openclaw-parallels-smoke` (`.agents/skills/openclaw-parallels-smoke/SKILL.md`) |
| macOS Discord roundtrip | `.agents/skills/parallels-discord-roundtrip/SKILL.md` |
| Doctor / legacy config | `docs/gateway/doctor.md` |
| Testing kit | `docs/help/testing.md` |
| Doc i18n details | `docs/.i18n/README.md` |
| exe.dev VM ops | `.agents/notes/exe-dev.md` |
| Local platform ops, version locations, Mac packaging, voice wake, A2UI hash, etc. | `.agents/notes/local-platform.md` |

## Misc

- Carbon: prefer latest published beta over stable; don't switch to stable casually.
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
