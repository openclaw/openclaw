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

**Source of truth**: repo-root `STATUS.md`

- On DevAgents: `/root/projects/openclaw/STATUS.md`
- In the local mirror: `/Users/liranperetz/clawdbot-worker/STATUS.md`
- Do **not** use the older copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless the user explicitly asks for it.

Rules:

- **READ** at session start (know what the other agent did)
- **CLAIM** your branch in `STATUS.md` before editing code
- **UPDATE** at session end (record what you did)
- **CHECK** before creating a branch (avoid conflicts)

### What to record

```markdown
| Repo               | Branch               | PR  | Status      | Owner  | Files / Areas Touched     | Validation   | Next Concrete Step                       | Notes                            |
| ------------------ | -------------------- | --- | ----------- | ------ | ------------------------- | ------------ | ---------------------------------------- | -------------------------------- |
| openclaw           | feat/healthcheck     | #2  | in_progress | Codex  | Dockerfile, src/health.ts | build passed | open PR and verify container health      | Adding HEALTHCHECK to Dockerfile |
| openclaw-dashboard | fix/deletion-cleanup | #26 | review      | Claude | app/agents/\*             | tests passed | address review feedback on deletion flow | Agent deletion fix               |
```

### Conflict check (mandatory before starting work)

1. Read `STATUS.md`
2. Confirm repo, branch ownership, and the files/areas you plan to touch
3. If the file/area you're about to modify is touched by the other agent's active branch → STOP
4. Tell the user: "The other agent has an active branch touching this area. Want me to wait or proceed on a separate file?"
5. If there is no overlap, claim your branch in `STATUS.md` before writing code

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

### Commit format (Conventional Commits)

```
feat(gateway): add health check endpoint
fix(agents): stop all services on deletion
chore(ci): add dashboard auto-deploy to Cloud Run
```

### PR process

1. Branch from fresh `main` (`git fetch origin && git checkout -b feat/... origin/main`)
2. Claim the branch in `STATUS.md` before editing
3. All tests/typechecks pass locally, or record exactly what did not run
4. Push + open PR with summary and test plan
5. Squash-merge to `main` (no merge commits)
6. Delete branch after merge

No direct pushes to `main`.

---

## 6. Repository Map

| Repo              | DevAgents Path                      | Local Mirror                            | Remote                         | Purpose                            |
| ----------------- | ----------------------------------- | --------------------------------------- | ------------------------------ | ---------------------------------- |
| Gateway (core)    | `/root/projects/openclaw`           | `/Users/liranperetz/clawdbot-worker`    | `cryptolir/openclaw`           | OpenClaw gateway, CLI, runtime     |
| Dashboard         | `/root/projects/openclaw-dashboard` | `/Users/liranperetz/openclaw-dashboard` | `cryptolir/openclaw-dashboard` | Next.js admin dashboard            |
| Coordination docs | `/root/projects/openclaw`           | `/Users/liranperetz/clawdbot-worker`    | —                              | `STATUS.md`, protocols, task brief |

Routine development, builds, git operations, and deployments happen on **DevAgents** unless the user explicitly asks to work from the local Mac.

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

## 8. Handoff Procedure

When one agent finishes a task the other agent should continue:

1. **Commit and push** all work to a named branch
2. **Update STATUS.md** with repo, branch name, owner transfer, files touched, validation result, blockers, and exact next step
3. **Leave a clear note** in the PR description or STATUS.md:

```
## Handoff to Claude
- Repo: openclaw
- Branch: feat/healthcheck
- Owner: Codex -> Claude
- Done: Dockerfile updated, health endpoint added
- Files / Areas Touched: Dockerfile, src/health.ts
- Validation: pnpm build passed; pnpm test not run
- Blockers: need runtime verification on DevAgents
- Next Concrete Step: deploy to EU and verify with docker logs
```

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
[ ] Confirm no overlap with the other agent before editing
[ ] Claim your branch in STATUS.md before writing code
```

## 11. Session End Checklist

```text
[ ] Relevant validation passes
[ ] Branch/PR state recorded if work started
[ ] STATUS.md updated with what changed, owner, branch, and blockers
[ ] Next concrete step recorded clearly
```
