# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-03-25 (session 4)
- **What happened**:
  - Merged dashboard PR #29: `fix(community): sync telegram group policies`
  - Merged dashboard PR #30: `fix(community): add manual telegram privacy status`
  - Replaced the inferred `Privacy Review` badge with a stored manual Telegram privacy status per Community row:
    - red `Privacy On`
    - green `Privacy Off`
    - gray `Privacy Unknown`
  - Added group-row editing for BotFather `/setprivacy` confirmation
  - Updated `openclaw-dashboard/GROUP_BEHAVIOR_POLICY_PLAN.md` to document the manual privacy-status model and its limitations
  - Deployed dashboard to Cloud Run revision `openclaw-dashboard-00145-mjp`
  - Pushed release tags `v2026.03.25.3` and `v2026.03.25.4`
- **Repos with uncommitted changes**:
  - `openclaw-dashboard`: local `AGENTS.md` edit still present and intentionally not committed

---

## Currently In Progress

- No active dashboard branch
- Future dashboard/project coordination work is documented in `openclaw-dashboard/GROUP_BEHAVIOR_POLICY_PLAN.md`

---

## Next Up (priority order)

1. Add structured `group_behavior_policies` storage (see GROUP_BEHAVIOR_POLICY_PLAN.md)
2. Add runtime enforcement for group-scoped file visibility, file creation, and project update permissions
3. Add canonical `projects` and `project_group_bindings`
4. Continue gateway CI/deploy follow-up in `clawdbot-worker`
5. Decide explicit owner-identity mapping for project approval flows

---

## Blockers / Open Questions

- Telegram privacy mode still cannot be verified via Bot API; the dashboard status is manually confirmed from BotFather
- Privacy mode is technically per bot/account, but the current dashboard stores it per group row because Community docs do not yet carry normalized Telegram account IDs
- Verify goimpact cleanup on server (leftover files after dashboard deletion?)

---

## Active Branches / PRs

| Branch                                | PR                              | Status      | Owner  | Notes                                               |
| ------------------------------------- | ------------------------------- | ----------- | ------ | --------------------------------------------------- |
| chore/staging-deploy-gcp              | cryptolir/openclaw#1            | open        | Claude | GCP workflow replacement                            |
| —                                     | cryptolir/openclaw-dashboard#27 | merged      | Codex  | Agent-page privacy review warning                   |
| —                                     | cryptolir/openclaw-dashboard#28 | merged      | Codex  | Community per-group privacy review warning          |
| —                                     | cryptolir/openclaw-dashboard#29 | merged      | Codex  | Sync Telegram group policy from agent config        |
| —                                     | cryptolir/openclaw-dashboard#30 | merged      | Codex  | Manual Telegram privacy on/off status per group row |
| fix/community-telegram-privacy-status | —                               | in_progress | Codex  | Manual Telegram privacy on/off status per group row |

---

## Recent Deploys

| Tag           | Date       | Notes                                                                         |
| ------------- | ---------- | ----------------------------------------------------------------------------- |
| v2026.03.25.4 | 2026-03-25 | Manual Telegram privacy status stored per Community row + handoff plan update |
| v2026.03.25.3 | 2026-03-25 | Sync Telegram group policy from agent config into Community docs              |
| v2026.03.25.2 | 2026-03-25 | Community-tab per-group privacy review + clarified handoff plan               |
| v2026.03.25.1 | 2026-03-25 | Dashboard privacy review tag + bot-group design note                          |

---

## Quick Reminders

- EU server: `89.167.70.46` (2 agents: openclaw, mikyhelper — goimpact deleted)
- US server: `5.161.84.219` (standby, empty)
- Dashboard: https://openclaw-dashboard-296319693396.europe-west1.run.app
- Registry: `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway:{tag}`
- Gateway repo: `/Users/liranperetz/clawdbot-worker` → `cryptolir/openclaw`
