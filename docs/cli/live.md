---
summary: "CLI reference for `openclaw live`, the live vs draft control plane for local Codex and Telegram-driven changes"
read_when:
  - You need to understand which checkout is live versus draft
  - You are promoting draft work into the Telegram-facing runtime
  - You are coordinating parallel work across Codex, OpenClaw, or gstack lanes
title: "live"
---

# `openclaw live`

`openclaw live` makes the live/draft boundary explicit.

Use it when you want one boring, clean live checkout for the running gateway and one or more draft worktrees for in-progress changes. Draft work does not become live until you promote it.

## Usage

```bash
openclaw live status
openclaw live sync
openclaw live sync --apply
openclaw live start
openclaw live propose codex-local
openclaw live promote /path/to/draft
openclaw live promote rollback
openclaw live journal --limit 20
```

## Model

- Live state: the canonical checkout that the Telegram-facing gateway runs from.
- Draft state: dedicated worktrees for local Codex work or agent-proposed changes.
- Promoted state: the specific commit most recently validated and promoted into the live lane.

`gateway:watch` remains available as a development reload primitive, but it is not the trust boundary. The runtime only changes when you restart from the live checkout or promote a draft into live state.

## Subcommands

- `status`: show the current live checkout, runtime source, watcher state, recent journal entries, and draft worktrees with clean/dirty state.
- `sync`: compare the live checkout against `origin/main`, verify the fork-backed safety gates, and optionally apply the update with rollback.
- `start`: restart the runtime from the current live checkout after verifying the live lane is safe.
- `propose <name>`: create a dedicated draft worktree rooted under `~/.openclaw/live-control/drafts`.
- `promote <source>`: fast-forward the live checkout from a clean draft worktree, build it, smoke-check the runtime, restart, and append a journal entry.
- `promote rollback`: reset the live checkout back to the previous promoted commit, then rebuild and restart.
- `journal`: inspect recent live-control events.

## Common options

- `status`: `--checkout <path>`, `--limit <n>`, `--json`
- `sync`: `--checkout <path>`, `--actor <name>`, `--apply`, `--build-timeout <ms>`, `--smoke-timeout <ms>`, `--json`
- `start`: `--checkout <path>`, `--actor <name>`, `--smoke-timeout <ms>`
- `propose <name>`: `--checkout <path>`, `--actor <name>`, `--message <text>`
- `promote <source>`: `--checkout <path>`, `--actor <name>`, `--build-timeout <ms>`, `--smoke-timeout <ms>`
- `journal`: `--checkout <path>`, `--limit <n>`, `--json`

## Fork-backed upstream sync

For a fork-backed install, keep the update flow in three separate steps:

1. Prepare the fork PR with `node scripts/upstream-sync.mjs --open-pr`.
2. Merge that PR into your fork's `main`.
3. Apply the merged fork update on the live machine with `openclaw live sync --apply`.

`openclaw live sync` is the local guardrail. It checks that the live checkout is your fork, still on `main`, clean, has no draft lanes, and that the running gateway still matches the live checkout before it fast-forwards to `origin/main`.

`openclaw live sync --json` returns:

- `liveSha`
- `originMainSha`
- `behindBy`
- `safeToApply`
- `blockers`
- `runtimeMatchesLive`
- `draftCount`
- `lockfileChanged`

When `--apply` is used, OpenClaw fast-forwards to `origin/main`, runs `pnpm install --frozen-lockfile` only when the lockfile changed, rebuilds, restarts, smoke-checks the runtime, and rolls back automatically if that sequence fails.

## Latest On Fork Vs Upstream

- Latest on your fork means the live checkout matches `origin/main`.
- Latest upstream OpenClaw means your fork has already merged the latest `upstream/main`.

Those are different states. `openclaw live sync` only applies changes that already landed in your fork.

## Notes

- Stable mode is healthy with watcher status `inactive`; that means dev reload is off, not that the live lane is broken.
- Dirty draft worktrees are expected during development. Dirty live checkouts are surfaced as issues because they blur the trust boundary.
- Journal and manifest state live under `~/.openclaw/live-control/`.
- For repo-local coordination, pair this command surface with the workflow guidance in `CLAUDE.md` / `AGENTS.md`.
