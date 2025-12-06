# Repository Guidelines

## Project Structure & Module Organization
- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Run CLI in dev: `pnpm clawdis ...` (tsx entry) or `pnpm dev` for `src/index.ts`.
- Type-check/build: `pnpm build` (tsc)
- Lint/format: `pnpm lint` (biome check), `pnpm format` (biome format)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Biome; run `pnpm lint` before commits.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Keep every file ≤ 500 LOC; refactor or split before exceeding and check frequently.

## Testing Guidelines
- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.

## Commit & Pull Request Guidelines
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.

## Security & Configuration Tips
- Web provider stores creds at `~/.clawdis/credentials/`; rerun `clawdis login` if logged out.
- Pi/Tau sessions live under `~/.clawdis/sessions/` by default; the base directory is not configurable.

## Agent-Specific Notes
- Relay is managed by launchctl (label `com.steipete.clawdis`). After code changes restart with `launchctl kickstart -k gui/$UID/com.steipete.clawdis` and verify via `launchctl list | grep clawdis`. Legacy label `com.steipete.warelay` still exists for rollback; prefer the new one. Use tmux only if you spin up a temporary relay yourself and clean it up afterward.
- Also read the shared guardrails at `~/Projects/oracle/AGENTS.md` and `~/Projects/agent-scripts/AGENTS.MD` before making changes; align with any cross-repo rules noted there.
- When asked to open a “session” file, open the Pi/Tau session logs under `~/.tau/agent/sessions/clawdis/*.jsonl` (newest unless a specific ID is given), not the default `sessions.json`.
- Menubar dimming + restart flow mirrors Trimmy: use `scripts/restart-mac.sh` (kills all Clawdis variants, runs `swift build`, packages, relaunches). Icon dimming depends on MenuBarExtraAccess wiring in AppMain; keep `appearsDisabled` updates intact when touching the status item.

## Exclamation Mark Escaping Workaround
The Claude Code Bash tool escapes `!` to `\\!` in command arguments. When using `clawdis send` with messages containing exclamation marks, use heredoc syntax:

```bash
# WRONG - will send "Hello\\!" with backslash
clawdis send --to "+1234" --message 'Hello!'

# CORRECT - use heredoc to avoid escaping
clawdis send --to "+1234" --message "$(cat <<'EOF'
Hello!
EOF
)"
```

This is a Claude Code quirk, not a clawdis bug.
