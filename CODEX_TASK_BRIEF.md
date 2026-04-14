# OpenClaw — Codex Task Brief

> **Use this when starting a Codex session for OpenClaw.**
> Last updated: 2026-04-14

---

## 1. Start Here

Work from `DevAgents` unless the user explicitly asks otherwise.

```text
1. ssh DevAgents
2. cd /root/projects/openclaw
3. Read STATUS.md
4. Read MULTI_AGENT_PROTOCOL.md
5. Read AGENTS.md
6. Read this file
7. Check git status and current branch
8. Confirm no overlap with Claude before editing
```

Repo-root `STATUS.md` is the live source of truth. Do not use the older legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## 2. Repositories

| Repo      | DevAgents Path                      | Local Mirror Path                       | Remote                                            | Purpose                      |
| --------- | ----------------------------------- | --------------------------------------- | ------------------------------------------------- | ---------------------------- |
| Gateway   | `/root/projects/openclaw`           | `/Users/liranperetz/clawdbot-worker`    | `git@github.com:cryptolir/openclaw.git`           | Core runtime, CLI, gateway   |
| Dashboard | `/root/projects/openclaw-dashboard` | `/Users/liranperetz/openclaw-dashboard` | `git@github.com:cryptolir/openclaw-dashboard.git` | Next.js admin UI (Cloud Run) |

Routine development, builds, git operations, and deploy orchestration should happen on DevAgents.

---

## 3. Multi-Agent Rules

**One branch = one owner. Check `STATUS.md` before doing anything else.**

| Rule             | Detail                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Branch ownership | Do not touch a branch or file area Claude is actively using                 |
| STATUS.md        | Read at start, update at end, and re-check before claiming a branch         |
| Commits          | Use Conventional Commits                                                    |
| PRs              | Branch from fresh `main`, validate, push, open PR, squash-merge             |
| No direct pushes | Never push directly to `main`                                               |
| No stash         | Do not create, apply, or drop git stash entries                             |
| No force-push    | Never force-push shared branches                                            |
| Handoff          | If stopping mid-task, record branch, owner, done, and blockers in STATUS.md |

If ownership is unclear, stop and ask before editing that area.

---

## 4. Current Repo State

Use `STATUS.md` as canonical, but the current known state is:

- Current next-up item: take control of the AgentGlob repo (see ROADMAP.md for full list)
- Gateway blocker: Venice model discovery times out at startup and falls back to the static catalog
- `chore/staging-deploy-gcp` is still listed as open and stale; treat it as active until ownership is verified
- Dashboard CI/CD is live: merging `openclaw-dashboard` `main` auto-deploys to Cloud Run and auto-tags releases
- Dashboard repo on DevAgents is up to date with `main`

---

## 5. Validation Commands

### Gateway

```bash
cd /root/projects/openclaw
pnpm install
pnpm build
pnpm test
pnpm check
```

### Dashboard

```bash
cd /root/projects/openclaw-dashboard
npm run build
```

If dependencies are missing, run the repo install command and retry the exact command once.

---

## 6. Deploy Rules

### Dashboard

- Normal deploy path: merge to `main`
- Do not do routine manual deploys unless explicitly requested
- Production URL: `https://app.agentglob.com`

### Gateway

Run from DevAgents:

```bash
/opt/openclaw-ops/scripts/build-and-push.sh <tag>
/opt/openclaw-ops/scripts/deploy.sh <tag>
```

Tag format:

```text
vYYYY.M.D.N
vYYYY.M.D.N-hotfix
```

---

## 7. Infrastructure Quick Reference

| Server     | IP                | Role                    |
| ---------- | ----------------- | ----------------------- |
| DevAgents  | `204.168.223.245` | Primary dev host        |
| EU prod    | `89.167.70.46`    | Primary production host |
| US standby | `5.161.84.219`    | Standby production host |

Operational reminders:

- Always resolve the agent server from Firestore before SSH or RPC
- Never hardcode EU when routing to an Agent
- Always use `getAllDashboardOrigins()` rather than `getDashboardOrigin()` for allowed origins

Terminology:

- Agent = one full Hetzner Docker Compose deployment
- Bot = one channel inside an Agent
- Org = dashboard-level unit in Firestore
- Workspace = per-Agent local dir on Hetzner

---

## 8. Session End Checklist

```text
[ ] Relevant validation passed
[ ] Work committed with Conventional Commit format if requested
[ ] PR opened if the work is ready
[ ] STATUS.md updated with what changed, branch, owner, and blockers
```
