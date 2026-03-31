# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-03-31 (session 10)
- **What happened**:
  - Chat widget full redesign: split layout (settings sidebar + smartphone chat), markdown rendering, file attachments, message queue, footer rebranded to AgentGlob
  - Default primary model changed to `venice/qwen3-235b-a22b-instruct-2507`
  - Fixed deploy route: gateway token + allowedOrigins now always persisted to Firestore on every deploy (first + redeploy)
  - Bulk-fixed 12 agents missing gateway tokens on EU + US servers (generated, wrote to containers, restarted, updated Firestore)
  - Updated CLAUDE.md release protocol: every change must deploy + commit + PR + merge + tag in same session
  - Cleaned up: dropped stale stash, deleted 20 local branches, pruned remote refs
  - PRs #38, #40 squash-merged. Tags `v2026.03.30.1`, `v2026.03.30.3`
  - Deployed revisions `00168` through `00177` (current: `00177-qff`)
- **Sync state**: local = remote = prod. `main` clean, 1 branch, 0 stash, 0 uncommitted code

---

## Currently In Progress

Nothing. `main` is clean and fully deployed. Ready for remote dev server migration.

---

## Next Up (priority order)

1. Migrate dev work to remote server
2. Clean signup/signin flow with email verification
3. Subscription plan selection & enforcement
4. Billing UI/reporting on top of stored monthly usage (reporting pages already scaffolded)
5. Group behavior policies (see `GROUP_BEHAVIOR_POLICY_PLAN.md`)

---

## Blockers / Open Questions

- Venice model discovery times out at gateway startup → falls back to static catalog. Gateway-side fix needed.
- 1 untracked file in repo: `install-devtools.sh` (not committed, harmless)

---

## Active Branches / PRs

| Branch                   | PR  | Status | Notes                            |
| ------------------------ | --- | ------ | -------------------------------- |
| chore/staging-deploy-gcp | #1  | open   | GCP workflow replacement (stale) |

---

## Recent Deploys

| Revision | Date       | Notes                                                                    |
| -------- | ---------- | ------------------------------------------------------------------------ |
| 00177    | 2026-03-31 | fix: always persist gateway token + origins to Firestore on every deploy |
| 00176    | 2026-03-31 | Chat widget error logging — console.error instead of bare catch          |
| 00172    | 2026-03-30 | Chat widget redesign + message queue + mobile sidebar + file attachments |

---

## Quick Reminders

- EU server (1stClaw): `89.167.70.46` — 12 agents
- US server (2ndClaw): `5.161.84.219` — 4 agents (projectmanager, social-bob, bob-the-project-manager, productguy)
- Dashboard: https://app.agentglob.com (also: https://openclaw-dashboard-296319693396.europe-west1.run.app)
- Always use `getAllDashboardOrigins()` not `getDashboardOrigin()` for allowedOrigins
- Always resolve agent server from Firestore before SSH/RPC — never hardcode EU
- SA key deleted — recreate from `openclaw-firestore-admin` when needed
