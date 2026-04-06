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
- `start`: restart the runtime from the current live checkout after verifying the live lane is safe.
- `propose <name>`: create a dedicated draft worktree rooted under `~/.openclaw/live-control/drafts`.
- `promote <source>`: fast-forward the live checkout from a clean draft worktree, build it, smoke-check the runtime, restart, and append a journal entry.
- `promote rollback`: reset the live checkout back to the previous promoted commit, then rebuild and restart.
- `journal`: inspect recent live-control events.

## Common options

- `status`: `--checkout <path>`, `--limit <n>`, `--json`
- `start`: `--checkout <path>`, `--actor <name>`, `--smoke-timeout <ms>`
- `propose <name>`: `--checkout <path>`, `--actor <name>`, `--message <text>`
- `promote <source>`: `--checkout <path>`, `--actor <name>`, `--build-timeout <ms>`, `--smoke-timeout <ms>`
- `journal`: `--checkout <path>`, `--limit <n>`, `--json`

## Notes

- Stable mode is healthy with watcher status `inactive`; that means dev reload is off, not that the live lane is broken.
- Dirty draft worktrees are expected during development. Dirty live checkouts are surfaced as issues because they blur the trust boundary.
- Journal and manifest state live under `~/.openclaw/live-control/`.
- For repo-local coordination, pair this command surface with the workflow guidance in `CLAUDE.md` / `AGENTS.md`.
