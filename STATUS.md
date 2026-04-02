# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-04-02 (session 11)
- **What happened**:
  - Set up DevAgents server (204.168.223.245) as dedicated dev environment
  - Installed Node 22, pnpm, gcloud CLI, gh CLI on DevAgents
  - Configured gh auth + gcloud auth on server
  - Added git sync discipline to dashboard CLAUDE.md
  - Created MULTI_AGENT_PROTOCOL.md and CODEX_TASK_BRIEF.md (merged via PR #2)
  - Created session protocol (STATUS.md, CLAUDE.md §0, §9 subagent patterns)
  - Fixed agent deletion bug (PR #26: `down -v` for all services, legacy guard)
  - Replaced docker-release.yml with staging-deploy.yml (PR #1: GCP Artifact Registry)
  - Set GitHub secrets: GCP_SA_KEY, HETZNER_SSH_KEY on cryptolir/openclaw
- **Sync state**: both repos pushed to main. DevAgents server repos need `git pull`

---

## Currently In Progress

DevAgents server (204.168.223.245) is fully set up. Ready to work from web/SSH sessions.
Run `git pull` on both repos on DevAgents before starting next session.

---

## Next Up (priority order)

1. ~~Migrate dev work to remote server~~ DONE
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

- **DevAgents**: `204.168.223.245` — dev server (repos, Claude CLI, builds)
- EU server (1stClaw): `89.167.70.46` — 12 agents
- US server (2ndClaw): `5.161.84.219` — 4 agents (projectmanager, social-bob, bob-the-project-manager, productguy)
- Dashboard: https://app.agentglob.com (also: https://openclaw-dashboard-296319693396.europe-west1.run.app)
- Always use `getAllDashboardOrigins()` not `getDashboardOrigin()` for allowedOrigins
- Always resolve agent server from Firestore before SSH/RPC — never hardcode EU
- SA key deleted — recreate from `openclaw-firestore-admin` when needed
