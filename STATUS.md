# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-03-30 (session 6 — continuation of session 5)
- **What happened**:
  - Fixed per-agent gateway token mismatch: `chatSendAndWait()` now accepts per-agent `gatewayToken` from Firestore
  - Fixed `getAllDashboardOrigins()`: deploy route + gateway-setup now always write BOTH `app.agentglob.com` AND the Cloud Run URL to `allowedOrigins` — agents on EU and US stay reachable regardless of active domain
  - Fixed Venice model IDs: `venice/mistral-31-24b` no longer exists in Venice API → replaced with `venice/mistral-small-3-2-24b-instruct` across all 10 affected agents on both servers + dashboard dropdown
  - Added new Venice models to dropdown: `qwen3-235b-a22b-instruct-2507`, `llama-3.2-3b`
  - Deleted stale Telegram webhook on productguy (was causing `getUpdates conflict` every 30s)
  - Updated CLAUDE.md with Section 8b "Multi-Server Rules (EU + US)"
  - Deployed 3 Cloud Run revisions: `00165` → `00166` → `00167-vxf` (current)
- **Local branch**: `fix/sync-serialization` — commits `67ddbf0`, `d6801c9`, `1561d9b` NOT pushed to GitHub yet
- **Auth audit**: No approval flow, no email verification, no password on signup — ready for subscription model

---

## Currently In Progress

- **Dashboard local checkout** (`/Users/liranperetz/openclaw-dashboard`) on `fix/sync-serialization` has 3 unpushed commits + other uncommitted WIP
- Need to push or clean-merge these changes to `main` before next feature work

---

## Next Up (priority order)

1. **Session start checklist**:
   - Read this STATUS.md
   - Push local commits to GitHub: `cd /Users/liranperetz/openclaw-dashboard && git push origin fix/sync-serialization`
   - Test webchat on `app.agentglob.com/chat/productguy` — verify token fix works
   - Test webchat on `app.agentglob.com/chat/specy` — verify Venice model fix works
2. Clean signup/signin flow with email verification
3. Subscription plan selection & enforcement
4. Billing UI/reporting on top of stored monthly usage
5. Group behavior policies (see `GROUP_BEHAVIOR_POLICY_PLAN.md`)

---

## Blockers / Open Questions

- Venice model discovery times out at gateway startup → falls back to static catalog that has NO Venice models. Works when discovery succeeds. Gateway-side fix needed for reliability.
- Local dashboard checkout has diverged from GitHub `main` — needs cleanup before PRs

---

## Active Branches / PRs

| Branch                   | PR  | Status      | Notes                                                        |
| ------------------------ | --- | ----------- | ------------------------------------------------------------ |
| fix/sync-serialization   | —   | in_progress | 3 unpushed commits: token fix, origins fix, Venice model fix |
| chore/staging-deploy-gcp | #1  | open        | GCP workflow replacement (stale)                             |

---

## Recent Deploys

| Revision | Date       | Notes                                                      |
| -------- | ---------- | ---------------------------------------------------------- |
| 00167    | 2026-03-30 | Venice model ID fix + new models in dropdown               |
| 00166    | 2026-03-30 | getAllDashboardOrigins + per-agent token fix               |
| 00165    | 2026-03-29 | Earlier deploy (did NOT include token fix — was in-flight) |

---

## Quick Reminders

- EU server (1stClaw): `89.167.70.46` — 12 agents
- US server (2ndClaw): `5.161.84.219` — 4 agents (projectmanager, social-bob, bob-the-project-manager, productguy)
- Dashboard: https://app.agentglob.com (also: https://openclaw-dashboard-296319693396.europe-west1.run.app)
- Always use `getAllDashboardOrigins()` not `getDashboardOrigin()` for allowedOrigins
- Always resolve agent server from Firestore before SSH/RPC — never hardcode EU
- Temp SA key at `/tmp/sa-key-temp.json` — delete when no longer needed
