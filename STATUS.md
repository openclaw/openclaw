# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-03-29 (session 5)
- **What happened**:
  - Fixed broadcast message failure for Telegram group "Product Dev - Netafim" (was routing to wrong server)
  - Added pricing info next to LLM model names in Config and Agents dropdowns
  - Added missing models: `openai/gpt-5-nano`, `openai/gpt-4.1-nano`
  - Fixed Community tab showing wrong agent's groups (cross-org contamination)
  - Added "Copy from existing" MCP server dropdown for config reuse
  - Fixed misleading "/start sets first owner" text in Bot Owners section
  - Merged Bot Owners + Admin Users into single "👑 Elevated Access" section
  - **Root cause diagnosis**: Per-agent gateway tokens introduced in deploy process, but public chat API was still using global `OPENCLAW_GATEWAY_TOKEN` env var → token mismatch errors
  - **Fix committed**: `67ddbf0` - `fix(public-chat): use per-agent gateway token for auth`
    - Modified `chatSendAndWait()` to accept optional `gatewayToken` parameter
    - Updated public chat route to pass `agent.gatewayToken` from Firestore
  - Deploy to Cloud Run in progress (started 2026-03-29 22:xx local time)
- **Auth system audit**: Discovered approval flow was removed; new users now auto-activate with workspace creation
  - No email verification currently implemented
  - No password setting during email signup (users created with provider="credentials" but no hash)
  - Ready for subscription model integration
- **Repos with uncommitted changes**:
  - `openclaw-dashboard`: Deploy commit `67ddbf0` created locally but not yet pushed (system resource limits on local Mac)

---

## Currently In Progress

- **Dashboard deploy**: Cloud Run revision pending completion (public-chat token fix)
- **Git push blocked**: Local commit `67ddbf0` ready to push but system resource limits hit on Mac
  - Next session should: `git push origin main` to sync upstream
- **Dashboard improvements** (to be done in next session):
  - Clean signup/signin flow with email verification
  - Email sending infrastructure (Resend, SendGrid, or similar)
  - Password capture during email signup (currently missing)
  - Subscription plan integration
- Dashboard local checkout on `fix/sync-serialization` has unrelated billing usage aggregation work by Codex (not committed)

---

## Next Up (priority order)

1. **Session start checklist** (new session):
   - Read this STATUS.md to recap (← you are here)
   - Check if Cloud Run deploy revision `openclaw-dashboard-00154-zfs` is live
   - Push commit `67ddbf0` to GitHub (`git push origin main`)
   - Test specy agent chat to verify token fix is working

2. Implement clean email verification signup flow
3. Add subscription plan selection & enforcement
4. Add structured `group_behavior_policies` storage (see GROUP_BEHAVIOR_POLICY_PLAN.md)
5. Extract dashboard billing aggregation changes into clean branch (`feat/billing-usage-aggregation`)
6. Continue gateway CI/deploy follow-up

---

## Blockers / Open Questions

- Telegram privacy mode still cannot be verified via Bot API; the dashboard status is manually confirmed from BotFather
- Privacy mode is technically per bot/account, but the current dashboard stores it per group row because Community docs do not yet carry normalized Telegram account IDs
- Verify goimpact cleanup on server (leftover files after dashboard deletion?)

---

## Active Branches / PRs

| Branch                                | PR                              | Status      | Owner  | Notes                                                                                                      |
| ------------------------------------- | ------------------------------- | ----------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| chore/staging-deploy-gcp              | cryptolir/openclaw#1            | open        | Claude | GCP workflow replacement                                                                                   |
| fix/sync-serialization                | —                               | in_progress | Codex  | Dashboard checkout currently also carries billing usage aggregation WIP; extract to clean branch before PR |
| —                                     | cryptolir/openclaw#3            | merged      | Codex  | Usage report RPC + tests                                                                                   |
| —                                     | cryptolir/openclaw#4            | merged      | Codex  | Usage report aggregation speedup + rollout tag                                                             |
| —                                     | cryptolir/openclaw-dashboard#27 | merged      | Codex  | Agent-page privacy review warning                                                                          |
| —                                     | cryptolir/openclaw-dashboard#28 | merged      | Codex  | Community per-group privacy review warning                                                                 |
| —                                     | cryptolir/openclaw-dashboard#29 | merged      | Codex  | Sync Telegram group policy from agent config                                                               |
| —                                     | cryptolir/openclaw-dashboard#30 | merged      | Codex  | Manual Telegram privacy on/off status per group row                                                        |
| fix/community-telegram-privacy-status | —                               | in_progress | Codex  | Manual Telegram privacy on/off status per group row                                                        |

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
