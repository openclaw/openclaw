# OpenClaw — Codex CLI Project Instructions

## Stack

- TypeScript (strict), Node.js, pnpm monorepo
- Tests: Vitest (898+ tests, `pnpm test`), Playwright for browser
- Formatter: oxfmt v0.28.0 (`pnpm exec oxfmt --write <file>`)
- Linter: oxlint, Type checker: tsgo
- Build: `pnpm build && pnpm check && pnpm test`

## Structure

- `src/` — source code (CLI, commands, channels, browser, config, gateway, agents, media)
- `dist/` — built output (patched runtime files live here)
- `extensions/` — plugin workspace packages
- `docs/` — Mintlify docs (docs.openclaw.ai)
- `apps/android/` — Android app (DO NOT TOUCH)

## Conventions

- Tests colocated as `*.test.ts` next to source
- Commits via `scripts/committer` (scoped, explicit file names)
- NEVER `git push` — the Dev agent handles push on the distribution repo
- NEVER `git add .` — stage only files you modified
- If tests fail → revert, do NOT commit broken code
- `atomic_write_json` pattern for all JSON writes (temp + rename)
- After editing .ts/.tsx/.js/.jsx, run: `pnpm exec oxfmt --write <file>`

## Protected Files (DO NOT MODIFY)

Intentional patches in `~/.openclaw/docs/ARCHITECTURE.md` §14:

- `apps/android/` (3 files)
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/browser/chrome.ts`
- `src/config/types.whatsapp.ts`
- `src/config/zod-schema.providers-whatsapp.ts`

## Architecture Reference

Always read `~/.openclaw/docs/ARCHITECTURE.md` before structural changes.
5 agents, 60+ crons, 16 runtime patches, anti-patterns (§10.3).

## Post-Upgrade Patch System (CRITICAL)

After `npm update -g openclaw`, dist files are overwritten → runtime patches lost.

```bash
openclaw-update  # alias in ~/.bashrc
# = npm update + apply-all-patches.sh + restart gateway + check-patches.sh
```

11 active patches (C/D/E/F/J/K/L/M2-M4/N/O/P) across chrome-_.js, reply-_.js, config-\*.js, etc.
6 patches retired (A/B/G/H/I/M1 — integrated upstream).

## Autonomy

- Full permissions — no approval needed for file modifications
- Direct access to all directories
- `.ssh/` accessible for git operations
