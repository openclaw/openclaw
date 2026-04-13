# OpenClaw — Dev Status

> Claude and Codex read this at session start and update it at session end.
> Repo-root `STATUS.md` is the only live source of truth. Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## Last Session

- **Date**: 2026-04-13 (handover refresh)
- **What changed**:
  - Confirmed `DevAgents` (`root@204.168.223.245`) as the primary development host for routine gateway/dashboard work, builds, git operations, and deploy orchestration
  - Confirmed canonical repo-root startup read order on DevAgents: `STATUS.md` → `MULTI_AGENT_PROTOCOL.md` → `AGENTS.md` → `CODEX_TASK_BRIEF.md`
  - Verified dashboard CI/CD is live: merging `openclaw-dashboard` `main` auto-deploys to Cloud Run and auto-tags releases
  - Verified the dashboard repo on DevAgents is up to date with `main`
  - Reconfirmed the gateway blocker: Venice model discovery times out at startup and falls back to the static catalog
- **Sync state**: re-check `STATUS.md` before creating a branch; one branch = one owner

---

## Currently In Progress

- Fresh-session coordination reset on DevAgents
- No new Codex branch claimed yet in the gateway repo

---

## Next Up (priority order)

1. Take control of the AgentGlob repo
2. Clean signup/signin flow with email verification
3. Subscription plan selection and enforcement
4. Billing UI/reporting on top of stored monthly usage
5. Group behavior policies (see `GROUP_BEHAVIOR_POLICY_PLAN.md` when working in dashboard)

---

## Blockers / Open Questions

- Gateway: Venice model discovery still times out during startup and falls back to the static catalog
- Coordination: confirm ownership before touching any branch or file area Claude is actively editing
- Branch hygiene: `chore/staging-deploy-gcp` is still listed as open and appears stale; verify before reuse or cleanup

---

## Active Branches / PRs

| Branch                   | PR  | Status      | Owner   | Notes                                    |
| ------------------------ | --- | ----------- | ------- | ---------------------------------------- |
| chore/staging-deploy-gcp | #1  | open, stale | unknown | Treat as active until verified otherwise |

---

## Validation Commands

- Gateway: `cd /root/projects/openclaw && pnpm install && pnpm build && pnpm test && pnpm check`
- Dashboard: `cd /root/projects/openclaw-dashboard && npm run build`

---

## Deploy Rules

- Dashboard: normal path is merge to `main`; no routine manual deploys
- Gateway/runtime: run from DevAgents with `/opt/openclaw-ops/scripts/build-and-push.sh <tag>` then `/opt/openclaw-ops/scripts/deploy.sh <tag>`

---

## Quick Reminders

- Gateway repo on DevAgents: `/root/projects/openclaw`
- Dashboard repo on DevAgents: `/root/projects/openclaw-dashboard`
- Dashboard prod URL: `https://app.agentglob.com`
- Always resolve the agent server from Firestore before SSH/RPC; never hardcode EU
- Always use `getAllDashboardOrigins()` rather than `getDashboardOrigin()` for allowed origins
- Canonical terms: Agent = full deployment, Bot = channel inside Agent, Org = dashboard unit, Workspace = per-Agent local dir on Hetzner
