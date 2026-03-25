# OpenClaw — Multi-Agent Development Protocol

> **Shared rules for Claude Code and Codex working on the same codebase.**
> Both agents MUST follow this protocol. Violations cause merge conflicts and wasted work.

---

## 1. Core Rule: One Branch = One Owner

Every active branch has exactly ONE agent assigned. The other agent does not touch it.

```
Branch: feat/add-healthcheck
Owner:  Codex
Status: in_progress

Claude sees this → hands off. No commits, no rebases, no "helpful" fixes.
```

Ownership is tracked in `STATUS.md` under "Active Branches / PRs".

---

## 2. STATUS.md — Shared State File

**Location**: `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md`

Both agents:

- **READ** at session start (know what the other agent did)
- **UPDATE** at session end (record what you did)
- **CHECK** before creating a branch (avoid conflicts)

### What to record:

```markdown
| Branch               | PR  | Status      | Owner  | Notes                            |
| -------------------- | --- | ----------- | ------ | -------------------------------- |
| feat/healthcheck     | #2  | in_progress | Codex  | Adding HEALTHCHECK to Dockerfile |
| fix/deletion-cleanup | #26 | review      | Claude | Agent deletion fix               |
```

### Conflict check (MANDATORY before starting work):

1. Read STATUS.md
2. If the file/area you're about to modify is touched by the other agent's active branch → STOP
3. Tell the user: "Codex has an active branch touching this area. Want me to wait or proceed on a separate file?"

---

## 3. Agent Strengths — Assignment Guide

| Task Type                          | Best Agent      | Why                                       |
| ---------------------------------- | --------------- | ----------------------------------------- |
| Interactive debugging              | **Claude Code** | Real-time SSH, logs, back-and-forth       |
| Server ops (deploy, restart, logs) | **Claude Code** | SSH access, can verify in real time       |
| Architecture planning              | **Claude Code** | Conversation-driven, can ask questions    |
| Multi-step investigation           | **Claude Code** | Subagents for parallel research           |
| Batch code refactors               | **Codex**       | Async, can run long without blocking      |
| Writing tests                      | **Codex**       | Methodical, coverage-focused              |
| Documentation updates              | **Codex**       | Can process large doc sets                |
| CI/CD pipeline work                | **Either**      | Assign based on availability              |
| PR reviews                         | **Either**      | Assign based on who didn't write the code |

---

## 4. Commit & Branch Standards (Both Agents)

### Branch naming:

```
feat/{scope}-{description}     # New feature
fix/{scope}-{description}      # Bug fix
chore/{scope}-{description}    # Maintenance
docs/{description}             # Documentation only
hotfix/{description}           # Production emergency
```

### Commit format (Conventional Commits):

```
feat(gateway): add health check endpoint
fix(agents): stop all services on deletion
chore(ci): replace docker-release with staging-deploy
```

### PR process:

1. Branch from fresh `main` (`git fetch origin && git checkout -b feat/... origin/main`)
2. All tests/typechecks pass locally
3. Push + open PR with summary and test plan
4. Squash-merge to `main` (no merge commits)
5. Delete branch after merge

---

## 5. Repository Map

| Repo           | Local Path                                     | Remote                         | What                                |
| -------------- | ---------------------------------------------- | ------------------------------ | ----------------------------------- |
| Gateway (core) | `/Users/liranperetz/clawdbot-worker`           | `cryptolir/openclaw`           | OpenClaw gateway, CLI, runtime      |
| Dashboard      | `/Users/liranperetz/openclaw-dashboard`        | `cryptolir/openclaw-dashboard` | Next.js admin dashboard             |
| Server Config  | `/Users/liranperetz/Claw_01_on_Hetzner_server` | (not a git repo)               | Docs, STATUS.md, agent instructions |

---

## 6. Server & Infrastructure

### Servers:

| Server       | IP           | Role                                    | SSH                                                |
| ------------ | ------------ | --------------------------------------- | -------------------------------------------------- |
| EU (primary) | 89.167.70.46 | Active (2 agents: openclaw, mikyhelper) | `ssh -i ~/.ssh/hetzner-openclaw root@89.167.70.46` |
| US (standby) | 5.161.84.219 | Empty, ready                            | `ssh -i ~/.ssh/hetzner-openclaw root@5.161.84.219` |

### Registry:

```
europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway:{tag}
```

### Deploy pipeline (automated via GitHub Actions):

```
push to main → staging-deploy.yml → build → push to GCP → SSH deploy to EU
```

### Manual deploy (if needed):

```bash
# On EU server:
/opt/openclaw-ops/scripts/build-and-push.sh v2026.3.25.1
/opt/openclaw-ops/scripts/deploy.sh v2026.3.25.1
```

### Tag format:

```
v{YYYY.MM.DD.sequence}          # Normal release
v{YYYY.MM.DD.sequence}-hotfix   # Emergency fix
```

---

## 7. What NOT to Do (Both Agents)

- ❌ Push directly to `main` — always use a PR
- ❌ Work on a branch owned by the other agent
- ❌ Deploy without tests passing
- ❌ Skip container build before deploy
- ❌ Use `git stash` (the other agent may have stashes)
- ❌ Force-push to any shared branch
- ❌ Modify `STATUS.md` without reading it first
- ❌ SSH with more than 10 concurrent sessions
- ❌ Modify gateway config without restarting the container
- ❌ Move agents in Firestore without updating `workspaceId`
- ❌ Claim a deploy succeeded without showing docker logs
- ❌ Commit `.env` files, credentials, or API keys

---

## 8. Handoff Protocol

When one agent finishes a task that the other agent should continue:

1. **Commit and push** all work to a named branch
2. **Update STATUS.md** with:
   - What was done
   - What's left to do
   - Branch name and owner transfer (e.g., "Owner: Codex → Claude")
3. **Leave a clear note** in the PR description or STATUS.md:
   ```
   ## Handoff to Claude
   - Branch: feat/healthcheck
   - Done: Dockerfile updated, health endpoint added
   - Remaining: deploy to EU, verify with docker logs
   - Files touched: Dockerfile, src/health.ts
   ```

---

## 9. Current State Reference

### GitHub Secrets (cryptolir/openclaw):

- `GCP_SA_KEY` — GCP Artifact Registry service account JSON
- `HETZNER_SSH_KEY` — SSH key for root@89.167.70.46

### GitHub Secrets (cryptolir/openclaw-dashboard):

- Managed via Google Cloud Build (see `cloudbuild.yaml`)
- Secrets in GCP Secret Manager: AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, AUTH_SECRET, OPENCLAW_GATEWAY_TOKEN, SSH_PRIVATE_KEY

### Active CI/CD:

| Repo      | Workflow             | Trigger                 | Target                             |
| --------- | -------------------- | ----------------------- | ---------------------------------- |
| Gateway   | `staging-deploy.yml` | Push to main / v\* tags | GCP Artifact Registry → Hetzner EU |
| Dashboard | `cloudbuild.yaml`    | Cloud Build trigger     | GCR → Cloud Run                    |

---

## 10. Quick Checklist — Before Starting Any Work

```
[ ] Read STATUS.md
[ ] Check for active branches owned by the other agent
[ ] Confirm no overlap in files you're about to touch
[ ] Create branch from fresh main
[ ] Record your branch + ownership in STATUS.md
[ ] Do the work
[ ] Tests pass
[ ] Commit (Conventional Commits)
[ ] Push + PR
[ ] Update STATUS.md at session end
```
