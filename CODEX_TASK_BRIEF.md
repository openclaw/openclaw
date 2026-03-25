# OpenClaw — Codex Task Brief

> **Paste this into a Codex session or point Codex at this file when starting work.**
> Last updated: 2026-03-25

---

## 1. Before You Start — Read These Files

```
MANDATORY (read in order):
1. STATUS.md                    → (repo root) STATUS.md
2. MULTI_AGENT_PROTOCOL.md      → (repo root) MULTI_AGENT_PROTOCOL.md
3. AGENTS.md (per repo)         → auto-loaded in each repo

OPTIONAL (read when relevant):
4. GROUP_BEHAVIOR_POLICY_PLAN.md → ../openclaw-dashboard/GROUP_BEHAVIOR_POLICY_PLAN.md
```

---

## 2. Repositories

| Repo        | Local Path                                     | Remote                                            | Purpose                           |
| ----------- | ---------------------------------------------- | ------------------------------------------------- | --------------------------------- |
| Gateway     | `/Users/liranperetz/clawdbot-worker`           | `git@github.com:cryptolir/openclaw.git`           | Core runtime, CLI, gateway        |
| Dashboard   | `/Users/liranperetz/openclaw-dashboard`        | `git@github.com:cryptolir/openclaw-dashboard.git` | Next.js admin UI (Cloud Run)      |
| Server Docs | `/Users/liranperetz/Claw_01_on_Hetzner_server` | (not a git repo)                                  | STATUS.md, protocols, task briefs |

---

## 3. Multi-Agent Rules (Claude Code is the other agent)

**Core rule: one branch = one owner. Check STATUS.md before starting.**

| Rule             | Detail                                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| Branch ownership | If STATUS.md shows Claude owns a branch, do NOT touch it                       |
| STATUS.md        | Read at start, update at end — always                                          |
| Commits          | Conventional Commits: `feat(scope):`, `fix(scope):`, `chore(scope):`           |
| PRs              | Branch from fresh `main`, squash-merge, delete branch after merge              |
| No direct pushes | Always go through a PR — no exceptions                                         |
| No stash         | Don't create/apply/drop git stash (Claude may have stashes)                    |
| No force-push    | Never force-push to any branch                                                 |
| Handoff          | If you stop mid-task, record state in STATUS.md with your branch + what's left |

---

## 4. Available Work Queues

### Dashboard (`openclaw-dashboard`) — Next.js 15, Firestore, Cloud Run

**Ready to pick up:**

1. **Structured group behavior policies** (see `GROUP_BEHAVIOR_POLICY_PLAN.md`)
   - Add `group_behavior_policies` Firestore collection
   - Replace freeform-only group instructions with structured policy storage
   - Files likely touched: `lib/agents-store.ts`, Community tab components, API routes

2. **Runtime enforcement hooks**
   - Group-scoped file visibility, file creation, project update permissions
   - Depends on #1 above

3. **Project + group bindings model**
   - Canonical `projects` and `project_group_bindings` Firestore collections
   - Support Jojo's 3-file project workflow

**Dashboard build/deploy:**

```bash
# Typecheck + build
cd /Users/liranperetz/openclaw-dashboard
npm run build

# Deploy to Cloud Run
gcloud run deploy openclaw-dashboard \
  --source /Users/liranperetz/openclaw-dashboard \
  --project=gold-verve-459312-e7 \
  --region=europe-west1 \
  --quiet

# Tag after deploy
git tag v{YYYY.MM.DD.sequence} -m "description"
```

### Gateway (`clawdbot-worker`) — TypeScript, Docker, Hetzner

**Ready to pick up:**

4. **Add HEALTHCHECK to Dockerfile** (see CODEX_HANDOFF.md §1)
   - File: `/opt/openclaw/Dockerfile` (on server) or equivalent in repo
   - May need a `/health` endpoint in the gateway

5. **Main branch protection** (see CODEX_HANDOFF.md §4)
   - Enable via GitHub repo settings or `gh api`
   - Require PR reviews, require CI pass, no direct pushes

**Gateway build/test:**

```bash
cd /Users/liranperetz/clawdbot-worker
pnpm install
pnpm build        # typecheck + build
pnpm test         # vitest
pnpm check        # lint/format
```

---

## 5. What Claude Code Is Currently Handling

Check STATUS.md "Active Branches" for live status. As of last update:

| Branch                     | Repo    | Status                                |
| -------------------------- | ------- | ------------------------------------- |
| `chore/staging-deploy-gcp` | Gateway | PR #1 open — GCP workflow replacement |

**Do not touch these branches or their files.**

---

## 6. Infrastructure Quick Reference

### Servers

| Server       | IP             | Role                           |
| ------------ | -------------- | ------------------------------ |
| EU (primary) | `89.167.70.46` | 2 agents: openclaw, mikyhelper |
| US (standby) | `5.161.84.219` | Empty                          |

### SSH (if needed)

```bash
ssh -i /Users/liranperetz/.ssh/hetzner-openclaw \
    -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    root@89.167.70.46
```

### Docker on server

```bash
docker ps | grep openclaw                                    # list containers
docker logs openclaw-openclaw-gateway-1 -f                   # gateway logs
docker exec -it openclaw-openclaw-gateway-1 sh               # enter container
```

### Registry

```
europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway:{tag}
```

### Tag format

```
v{YYYY.MM.DD.sequence}          # e.g. v2026.03.25.5
v{YYYY.MM.DD.sequence}-hotfix   # emergency only
```

---

## 7. Firestore Collections

| Collection                            | Purpose           | Key fields                                                                 |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `agents/{id}`                         | Agent registry    | name, displayName, workspaceId, server, status, gatewayPort, containerName |
| `workspaces/{id}`                     | Org               | name, slug, plan, ownerId, agentCount                                      |
| `workspace_members/{wid}_{email}`     | Org membership    | workspaceId, email, workspaceRole, status                                  |
| `users/{email}`                       | User profile      | platformRole                                                               |
| `agent_port_allocations/{sid}_{port}` | Port reservations | serverId, gatewayPort, agentId                                             |

---

## 8. Terminology (use these everywhere)

| Term          | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Agent**     | A full OpenClaw Docker stack on Hetzner (gateway + bridge + workspace)                      |
| **Bot**       | A specific channel (WhatsApp, Telegram, etc.) running inside an Agent                       |
| **Org**       | Dashboard-level organizational unit (called `workspace` in code/Firestore — rename planned) |
| **Workspace** | Per-Agent local directory on Hetzner (`/root/.openclaw/agents/{name}/workspace/`)           |

---

## 9. Session End Checklist

Before finishing your session:

```
[ ] All tests pass (pnpm test / npm run build)
[ ] Changes committed with Conventional Commit format
[ ] PR created (if work is complete enough)
[ ] STATUS.md updated with:
    - What you did
    - Branch name + owner (Codex)
    - Any new blockers
    - Updated "Next Up" if priorities shifted
```
