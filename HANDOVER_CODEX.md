# Handover — Codex (OpenClaw)

Work from DevAgents: `ssh DevAgents`

## Before touching code

1. Read `STATUS.md`, `MULTI_AGENT_PROTOCOL.md`, `AGENTS.md`, `CODEX_TASK_BRIEF.md` (all in `/root/projects/openclaw/`)
2. Confirm Claude's active branches/files in `STATUS.md`
3. Claim your branch ownership in `STATUS.md` (one branch = one owner)
4. `cd` into the relevant repo:
   - Gateway: `/root/projects/openclaw`
   - Dashboard: `/root/projects/openclaw-dashboard`

## Multi-agent coordination with Claude

- Do not edit a Claude-owned branch or overlapping file area
- If overlap exists, stop and re-scope before coding
- Do not use `git stash` or force-push shared branches
- Use `scripts/committer "<msg>" <file...>` for commits (Conventional Commits format)

## Validation (on DevAgents, not local mirror)

- Gateway: `pnpm install && pnpm build && pnpm test && pnpm check`
- Dashboard: `npm run build`

## Deploy (only when asked)

- Dashboard: merge to `main` (CI/CD handles the rest)
- Gateway: `/opt/openclaw-ops/scripts/build-and-push.sh <tag>` then `deploy.sh <tag>`
- No ad-hoc `docker build` / manual compose edits unless explicitly requested

## Session end

Update `STATUS.md` with what you did, branch, owner, and any blockers.
