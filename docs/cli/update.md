---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw update` (safe-ish source update + gateway auto-restart)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to update a source checkout safely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to understand `--update` shorthand behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "update"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw update`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safely update OpenClaw and switch between stable/beta/dev channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you installed via **npm/pnpm** (global install, no git metadata), updates happen via the package manager flow in [Updating](/install/updating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --tag beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --no-restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-restart`: skip restarting the Gateway service after a successful update.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <stable|beta|dev>`: set the update channel (git + npm; persisted in config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tag <dist-tag|version>`: override the npm dist-tag or version for this update only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: print machine-readable `UpdateRunResult` JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <seconds>`: per-step timeout (default is 1200s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: downgrades require confirmation because older versions can break configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `update status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update status --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update status --timeout 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: print machine-readable status JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <seconds>`: timeout for checks (default is 3s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `update wizard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interactive flow to pick an update channel and confirm whether to restart the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
after updating (default is to restart). If you select `dev` without a git checkout, it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
offers to create one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you switch channels explicitly (`--channel ...`), OpenClaw also keeps the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
install method aligned:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dev` → ensures a git checkout (default: `~/openclaw`, override with `OPENCLAW_GIT_DIR`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  updates it, and installs the global CLI from that checkout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stable`/`beta` → installs from npm using the matching dist-tag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Git checkout flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stable`: checkout the latest non-beta tag, then build + doctor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `beta`: checkout the latest `-beta` tag, then build + doctor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dev`: checkout `main`, then fetch + rebase.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
High-level:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Requires a clean worktree (no uncommitted changes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Switches to the selected channel (tag or branch).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Fetches upstream (dev only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Dev only: preflight lint + TypeScript build in a temp worktree; if the tip fails, walks back up to 10 commits to find the newest clean build.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Rebases onto the selected commit (dev only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Installs deps (pnpm preferred; npm fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Builds + builds the Control UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Runs `openclaw doctor` as the final “safe update” check.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. Syncs plugins to the active channel (dev uses bundled extensions; stable/beta uses npm) and updates npm-installed plugins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## `--update` shorthand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw --update` rewrites to `openclaw update` (useful for shells and launcher scripts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor` (offers to run update first on git checkouts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Development channels](/install/development-channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Updating](/install/updating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [CLI reference](/cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
