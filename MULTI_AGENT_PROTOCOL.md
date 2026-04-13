# OpenClaw — Multi-Agent Development Protocol

> **Shared rules for Claude Code and Codex working on the same codebase.**
> Both agents MUST follow this protocol. Violations cause merge conflicts and wasted work.

---

## 1. Core Rule: One Branch = One Owner

Every active branch has exactly ONE agent assigned. The other agent does not touch it.

```
Branch: feat/example-scope
Owner:  Codex
Status: in_progress

Claude sees this -> hands off. No commits, no rebases, no "helpful" fixes.
```

Ownership is tracked in the repo-root `STATUS.md` under "Active Branches / PRs".

---

## 2. STATUS.md — Shared State File

**Location**: `/root/projects/openclaw/STATUS.md`

Rules:

- Read it at session start
- Re-check it before creating a branch
- Update it at session end
- Treat it as the only live source of truth for gateway coordination
- Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked

### What to record

```markdown
| Branch                   | PR  | Status      | Owner   | Notes                              |
| ------------------------ | --- | ----------- | ------- | ---------------------------------- |
| feat/example-scope       | #42 | in_progress | Codex   | Investigating Venice startup issue |
| chore/staging-deploy-gcp | #1  | open, stale | unknown | Verify ownership before touching   |
```

### Conflict check (mandatory before starting work)

1. Read `STATUS.md`
2. If the file area you want to modify is owned by the other agent, stop
3. Ask for clarification before proceeding in that area

---

## 3. Primary Development Host

Routine development now happens on `DevAgents`, not the local Mac mirror.

- SSH: `ssh DevAgents`
- Host: `root@204.168.223.245`
- Gateway repo: `/root/projects/openclaw`
- Dashboard repo: `/root/projects/openclaw-dashboard`

Local Mac mirrors are for reference unless the user explicitly asks otherwise.

---

## 4. Agent Strengths — Assignment Guide

| Task Type                          | Best Agent      | Why                                        |
| ---------------------------------- | --------------- | ------------------------------------------ |
| Interactive debugging              | **Claude Code** | Real-time SSH, logs, back-and-forth        |
| Server ops (deploy, restart, logs) | **Claude Code** | SSH access, can verify in real time        |
| Architecture planning              | **Claude Code** | Conversation-driven, can ask questions     |
| Multi-step investigation           | **Claude Code** | Subagents for parallel research            |
| Batch code refactors               | **Codex**       | Async, can run long without blocking       |
| Writing tests                      | **Codex**       | Methodical, coverage-focused               |
| Documentation updates              | **Codex**       | Can process large doc sets                 |
| CI/CD pipeline work                | **Either**      | Assign based on availability               |
| PR reviews                         | **Either**      | Assign based on who did not write the code |

---

## 5. Commit & Branch Standards

### Branch naming

```
feat/{scope}-{description}
fix/{scope}-{description}
chore/{scope}-{description}
docs/{description}
hotfix/{description}
```

### Commit format

```
feat(gateway): improve venice model discovery startup handling
fix(dashboard): correct signup verification redirect
chore(ci): clean up stale deploy workflow references
```

### PR process

1. Start from fresh `main` on DevAgents
2. Run the relevant validation commands
3. Push branch and open a PR
4. Squash-merge to `main`
5. Delete the branch after merge

No direct pushes to `main`.

---

## 6. Repository Map

| Repo           | DevAgents Path                      | Local Mirror Path                       | Purpose                        |
| -------------- | ----------------------------------- | --------------------------------------- | ------------------------------ |
| Gateway (core) | `/root/projects/openclaw`           | `/Users/liranperetz/clawdbot-worker`    | OpenClaw gateway, CLI, runtime |
| Dashboard      | `/root/projects/openclaw-dashboard` | `/Users/liranperetz/openclaw-dashboard` | Next.js admin dashboard        |

---

## 7. Infrastructure & Deploy

### Servers

| Server     | IP                | Role                          |
| ---------- | ----------------- | ----------------------------- |
| DevAgents  | `204.168.223.245` | Primary development host      |
| EU prod    | `89.167.70.46`    | Primary production Agent host |
| US standby | `5.161.84.219`    | Standby Agent host            |

### Dashboard

- Production URL: `https://app.agentglob.com`
- Normal deploy path: merge to `main`
- CI/CD: `main` auto-deploys to Cloud Run and auto-tags releases
- Avoid routine manual deploys unless explicitly requested

### Gateway

- Artifact Registry: `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway`
- Build/push from DevAgents: `/opt/openclaw-ops/scripts/build-and-push.sh <tag>`
- Deploy from DevAgents: `/opt/openclaw-ops/scripts/deploy.sh <tag>`
- Tag format: `vYYYY.M.D.N` or `vYYYY.M.D.N-hotfix`

---

## 8. Current Coordination Notes

- Treat `STATUS.md` as live state, even if older docs or chat notes disagree
- Current next-up item in `STATUS.md`: take control of the AgentGlob repo
- Current gateway blocker in `STATUS.md`: Venice model discovery times out at startup and falls back to the static catalog
- `chore/staging-deploy-gcp` is still listed as open and stale; verify ownership before touching it
- Always resolve agent server from Firestore before SSH or RPC; never hardcode EU
- Always use `getAllDashboardOrigins()` rather than `getDashboardOrigin()` for allowed origins

---

## 9. What Not To Do

- Do not work on a branch owned by the other agent
- Do not use `git stash`
- Do not force-push shared branches
- Do not push directly to `main`
- Do not claim a deploy succeeded without verification
- Do not hardcode the EU server when Firestore is the source of truth
- Do not use the local Mac mirror as the default development host

---

## 10. Session Start Checklist

```text
[ ] ssh DevAgents
[ ] cd /root/projects/openclaw
[ ] Read STATUS.md, MULTI_AGENT_PROTOCOL.md, AGENTS.md, CODEX_TASK_BRIEF.md
[ ] Check git status and current branch
[ ] Confirm no overlap with Claude before editing
```

## 11. Session End Checklist

```text
[ ] Relevant validation passes
[ ] Branch/PR state recorded if work started
[ ] STATUS.md updated with what changed, owner, branch, and blockers
```
