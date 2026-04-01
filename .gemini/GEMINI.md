# OpenClaw — Gemini CLI Project Instructions

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

## Protected Files (DO NOT MODIFY)

These are intentional patches documented in `~/.openclaw/docs/ARCHITECTURE.md` §14:

- `apps/android/` (3 files)
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/browser/chrome.ts`
- `src/config/types.whatsapp.ts`
- `src/config/zod-schema.providers-whatsapp.ts`

## Architecture Reference

Always read `~/.openclaw/docs/ARCHITECTURE.md` before making structural changes.
It documents: 5 agents (tigrou, finance, fedelia, fitness, dev), 60+ crons, patches, anti-patterns (§10.3), and ADRs (§14).

## Key Patterns

- Channels: core (`src/telegram`, `src/discord`, etc.) + extension channels (`extensions/*`)
- Plugin deps: `dependencies` (not `devDependencies`), avoid `workspace:*`
- Config: `openclaw.json` at `~/.openclaw/openclaw.json`
- Bootstrap files: AGENTS.md, TOOLS.md, SOUL.md, HEARTBEAT.md (max 20KB each)

## Communication with OpenClaw agents

```bash
openclaw agent --agent <agentId> --message "..." --json --timeout 120
```

Agents: tigrou, finance, fedelia, fitness, dev

## Post-Upgrade Patch System (CRITICAL)

After every `npm update -g openclaw`, the dist files are overwritten and runtime patches are lost.
The alias `openclaw-update` (in `~/.bashrc`) handles everything:

```bash
openclaw-update
# = npm update -g openclaw
# + ~/.openclaw/workspace/skills/claude-code-dev/scripts/patches/apply-all-patches.sh
# + systemctl --user restart openclaw-gateway
# + check-patches.sh
```

**11 active patches** (C/D/E/F/J/K/L/M2-M4/N/O/P) applied to chrome-_.js, reply-_.js, config-\*.js, etc.
6 patches retired (A/B/G/H/I/M1 — integrated upstream in v2026.2.19-2).
Full documentation: `~/.openclaw/docs/ARCHITECTURE.md` §14 (Hotfixes & patches runtime).

When modifying code that touches dist files or creating new patches:

- Update `apply-all-patches.sh` to include the new patch
- Add documentation to ARCHITECTURE.md §14
- Test with `--dry-run` before applying
- Always verify post-upgrade: `check-patches.sh`

## Autonomy

- You have FULL permission to read, write, edit, execute bash, and access all directories
- No approval needed for file modifications — you are running in autonomous mode
- `.ssh/` directory accessible for git operations
