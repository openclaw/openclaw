# Handover — Claude Code (OpenClaw)

Work from DevAgents: `ssh DevAgents`

## Before touching code

1. Read `STATUS.md`, `MULTI_AGENT_PROTOCOL.md`, `CODEX_TASK_BRIEF.md` (in `/root/projects/openclaw/`)
2. Confirm Codex's active branches/files in `STATUS.md`
3. Claim your branch in `STATUS.md` (one branch = one owner)
4. `cd` into the relevant repo:
   - Gateway: `/root/projects/openclaw`
   - Dashboard: `/root/projects/openclaw-dashboard`

`CLAUDE.md` (-> `AGENTS.md`) is auto-loaded — build commands, deploy protocol, coding style, and git workflow are already in context.

## Multi-agent coordination with Codex

- Do not edit a Codex-owned branch or overlapping file area
- If overlap exists, stop and re-scope before coding

## Deploy (only when asked)

- Dashboard: merge to `main` (CI/CD handles the rest)
- Gateway: `/opt/openclaw-ops/scripts/build-and-push.sh <tag>` then `deploy.sh <tag>`

## Session end

Update `STATUS.md` with what you did, branch, owner, and any blockers.
