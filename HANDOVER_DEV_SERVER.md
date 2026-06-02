# Handover — Working on the Dev Server (AgentGlob / OpenClaw / Havaya)

> **Golden rule:** all real work happens **on the dev server**, in a **git worktree
> cut from `origin/main`**, never on a local checkout and never on the server's
> stale `main`. Edit → gate → commit → push → PR → merge → (deploy). The same flow
> for all three repos.

---

## 1. Servers & access

All hosts use `IdentityFile ~/.ssh/hetzner-openclaw` (already in `~/.ssh/config`).
Connect with `ssh <alias> '<cmd>'`.

| Alias (SSH) | Host | Role |
|---|---|---|
| `DevAgents` | `204.168.223.245` | **Dev server — all repos checked out here. Do all editing/building here.** |
| `1stclaw` | (EU agent host) | Production agent host (EU region) |
| `2ndclaw` | `5.161.84.219` | Production agent host (US region). **The `life` agent (display name "Havaya.me") runs here.** |
| `coolify-host` / `webtester` | `178.104.184.3` | Coolify host that deploys **Havaya** (**owner-managed UI at `:8000` — the agent cannot reach it**) |

---

## 2. The three repos (source of truth = GitHub `cryptolir/*`)

| Repo (GitHub = source of truth) | On dev server | Stack | Deploys to / how |
|---|---|---|---|
| **`cryptolir/openclaw`** (gateway) | `/root/projects/openclaw` | pnpm monorepo; tsgo / oxfmt / oxlint / vitest | Per-agent Docker containers on `1stclaw`/`2ndclaw` via image tag + `scripts/ops/deploy.sh` |
| **`cryptolir/openclaw-dashboard`** | `/root/projects/openclaw-dashboard` | Next.js 15; `node:test` | Google Cloud Run (`europe-west1`) |
| **`cryptolir/app.havaya`** | `/root/projects/Havaya_App` | Next.js + Clerk + Prisma | **Coolify** (owner redeploys) |

> ⚠️ **`app.havaya` repo name ≠ on-disk dir `Havaya_App`.** Always pass
> `-R cryptolir/app.havaya` to `gh` to avoid the wrong-repo trap.

Other checkouts on the box (`Mn_agents`, `Panama-KYC`, `oc-gw-build`) are unrelated
to this integration. `oc-gw-build` is a **detached-HEAD build worktree** of openclaw
used for producing gateway images — don't develop in it.

**Current `origin/main` HEADs (2026-06-02):**
- openclaw — `ba70447a1` (STATUS.md sync #52)
- openclaw-dashboard — `61969a6` (streaming `appUserId` parity #110)
- app.havaya — `3471686` (favicon/app icons #10)

---

## 3. Git workflow (exactly what we've been doing)

The server's local `main` is often **stale and carries foreign WIP** — never edit it.
Always branch from `origin/main` in a fresh worktree under `/root/` (not `/tmp` —
something reaps `/tmp` between calls):

```bash
ssh DevAgents bash -s <<'EOF'
set -euo pipefail
cd /root/projects/<repo-dir>          # openclaw | openclaw-dashboard | Havaya_App
git fetch origin --quiet
git worktree add -b <branch> /root/<repo>-wt origin/main
# Next.js repos need node_modules — symlink the main checkout's:
ln -s /root/projects/<repo-dir>/node_modules /root/<repo>-wt/node_modules
EOF
```

**Editing remote files** (the Edit tool only touches the *local* FS — the repo is on
the server). Pick one:
- `scp local.ts DevAgents:/root/<repo>-wt/path.ts`
- write a Python exact-match patch script to `/tmp/x.py`, run `python3 /tmp/x.py`
- small edits: an `awk`/heredoc script copied to `/tmp`, then `bash /tmp/x.sh`
  (avoid deeply nested SSH heredocs + `$(...)`/`$VAR` — quoting breaks; write a file)

**Gate before committing** (per repo — see §4 for the exact gate):

**Commit** with the author + co-author trailer we've used:
```bash
git -c user.name="Liran Peretz" -c user.email="onetrue2023@gmail.com" \
  commit -q -F - <<'MSG'
feat(scope): one-line summary

Body: what + why. Note which gates ran.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```
If a **pre-commit hook fails on missing tooling** (we hit `oxfmt not found` on
openclaw), add `--no-verify` — it's an env gap, not a real failure.

**Push + PR + merge:**
```bash
git push -u origin <branch>
gh pr create -R cryptolir/<repo> --base main --head <branch> --title "..." --body "..."
gh pr merge <num> -R cryptolir/<repo> --squash --delete-branch
#   add --admin only if CI is pre-existing red AND the owner approved
```

**Clean up the worktree when done:**
```bash
ssh DevAgents 'cd /root/projects/<repo-dir> && rm -f /root/<repo>-wt/node_modules && \
  git worktree remove /root/<repo>-wt --force && git worktree prune'
```

---

## 4. Per-repo gates & deployment protocol

### 4a. `openclaw` (gateway)
- **Gate:** `pnpm -C /root/<repo>-wt install --frozen-lockfile` already covered by the
  main checkout; type/build check via the repo's tsgo build + `pnpm vitest run <area>`.
  For doc-only changes, no build needed.
- **Deploy (per-agent, image-tag based):**
  1. Build + push an image tagged `vYYYY.MM.DD.N` to the Artifact Registry
     `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway`
     (build from a clean checkout, e.g. `oc-gw-build`; `docker build -f Dockerfile`
     then `docker push`).
  2. **Whole-fleet rollout:** `scripts/ops/deploy.sh <tag> <1stclaw|2ndclaw|all>` —
     port-checks, pulls, updates **every** agent's `docker.env` `OPENCLAW_IMAGE`, then
     rolls out one agent at a time with health checks + rollback.
  3. **Single-agent (what we did for `life`):** pin only that agent and recreate only
     its container — **do NOT run the fleet `deploy.sh`** if you want to touch one agent:
     ```bash
     ssh 2ndclaw 'sed -i "s#^OPENCLAW_IMAGE=.*#OPENCLAW_IMAGE=<registry>:<tag>#" \
       /root/.openclaw/agents/life/docker.env && \
       cd /opt/openclaw && docker compose -p life \
       --env-file /root/.openclaw/agents/life/docker.env up -d openclaw-gateway'
     ```
  - **Verify:** `ssh 2ndclaw "docker ps --format '{{.Names}}\t{{.Image}}' | grep gateway"`.
    `life` is currently on `gateway:v2026.06.01.1` (the per-user writer image); the rest
    of the fleet is on older tags — that isolation is intentional.

### 4b. `openclaw-dashboard`
- **Gate:** `npm run build` (Next.js) and/or `node --test` for the touched area.
- **Deploy:** Google Cloud Run, `europe-west1`. Secrets (`SSH_PRIVATE_KEY`,
  `AGENTGLOB_APP_API_KEY`) live as Cloud Run secrets — **owner/operator-managed**.

### 4c. `app.havaya`
- **Gate:** `ssh DevAgents 'cd /root/<repo>-wt && npx tsc --noEmit && echo TSC_OK'`.
  ⚠️ **NEVER `npm run build` on Havaya** — its build runs `prisma migrate deploy`
  against a **real database**. `tsc --noEmit` fully covers type changes.
- **Deploy:** **Coolify, owner-managed.** After merge, ask the owner to redeploy
  (Coolify host `178.104.184.3:8000`). The agent cannot reach the Coolify UI.

---

## 5. Docs & files that must stay in sync

When you change behavior, update the matching docs **in the same PR**. Source-of-truth
docs per repo:

### `openclaw`
- **`STATUS.md`** — append a **"Last Session"** entry per working session (PRs, what
  shipped, deploys, security notes, validation). *This is the one most often forgotten.*
- **`docs/tools/save-user-section.md`** — the per-user writer tool (allowlist, identity
  flow, wiring, security). Registered in **`docs/docs.json`** under "Built-in tools".
- **`AGENTS.md`** (repo root) — repo-wide agent/dev conventions.

### `openclaw-dashboard`
- **`docs/peruser-user-file-asbuilt.md`** — as-built record of the read endpoint +
  `appUserId` passthrough (the current truth).
- **`docs/peruser-user-file-plan.md`** — original plan (carries a SHIPPED banner).
- *(`SESSION_SUMMARY.md` is a March-2026 legacy artifact — superseded by the as-built
  doc; leave it unless explicitly asked.)*

### `app.havaya`
- **`AGENTGLOB_INTEGRATION_STATUS.md`** — consumer as-built (start here).
- **`AGENTGLOB_USER_FILE_API.md`** — the read contract (SHIPPED banner).
- **`AGENTGLOB_PERUSER_GUIDANCE.md`**, **`AGENTGLOB.md`**, **`AGENTGLOB_IMPL_HANDOFF.md`** — rationale / handoff.
- **`ROADMAP.md`** — keep the per-user feature row in "Shipped".
- **`HANDOVER_HAVAYA_SESSION.md`** — the Havaya-app-specific handover (footer SHAs).

### On the agent host (`2ndclaw`, **not in git** — edit live, backup first)
- **`/root/.openclaw/agents/life/workspace/AGENTS.md`** — the **"App Profile Sections"**
  block telling the `life` agent when/how to call `save_user_section`. Takes effect on
  the agent's next turn (no redeploy). **Always back up first:**
  `cp AGENTS.md AGENTS.md.bak.$(date +%Y%m%d)`. This is **per-agent**: only `life` has it.

### Memory (this machine, persists across sessions)
- `~/.claude/.../memory/project_agentglob_userfile_api.md` (verified build facts)
- `~/.claude/.../memory/project_agentglob_writer_mapping.md` (writer wiring)
- `~/.claude/.../memory/reference_infra.md` (hosts, log/smoke commands)

---

## 6. AgentGlob per-user integration — shipped state (context)

Havaya's home hub shows per-user prompts + an owner note sourced from the `life`
agent's per-user workspace file. **Fully shipped & live (2026-06).**

End-to-end:
```
Havaya home page ──(server-side, Bearer AGENTGLOB_APP_API_KEY)──▶
  GET /api/public/chat/life/user-file?userId=<clerkUserId>&section=User_D_Prompt
     └─ dashboard reads workspace/users/<clerkUserId>.md over SSH → marked section.

Havaya chat ──(POST, body.appUserId = clerk userId)──▶ dashboard
  └─ forwards appUserId into gateway chat.send → persisted on SessionEntry
     └─ life agent calls save_user_section("User_D_Prompt"|"app_note")
        → writes workspace/users/<clerkUserId>.md (the same file read above).
```
- Both read **and** streaming chat paths forward `appUserId` (dashboard #108 buffered,
  #110 streaming `/stream`).
- Allowlisted sections: **`User_D_Prompt`**, **`app_note`** (only these are read/write).
- Filename on disk = **raw lowercased Clerk userId**; provisioning is **lazy**
  (read returns `404` → empty UI until the agent's first write — never an error).

---

## 7. Secrets — handling rule (learned the hard way)

- **`AGENTGLOB_APP_API_KEY`** must match on both sides:
  - Havaya: **Coolify env** (owner sets + redeploys).
  - Dashboard: **Cloud Run secret**.
- **NEVER commit the key to git** (any repo). We had a leak: the live key was committed
  to Havaya `main`; remediation required **rotating the key** *and* **rewriting git
  history** (`git filter-branch`, narrow `<sha>^..main` range; `--force-with-lease`).
- If a key is ever exposed: **rotate first** (decisive), then scrub history. The current
  live key lives only in Coolify env + the dashboard Cloud Run secret — get it from
  there, never from a doc or commit.

---

## 8. Quick verification commands

```bash
# Per-user files the agent has written (agent host):
ssh 2ndclaw 'ls -la /root/.openclaw/agents/life/workspace/users/'

# Which image each gateway runs (confirm life is pinned, fleet unchanged):
ssh 2ndclaw "docker ps --format '{{.Names}}\t{{.Image}}' | grep gateway"

# Reader smoke test against prod (proves key + endpoint). Paste key locally; never commit:
KEY=<paste from Coolify / Cloud Run>
curl -s -w ' [%{http_code}]\n' -H "Authorization: Bearer $KEY" \
  "https://app.agentglob.com/api/public/chat/life/user-file?userId=<clerkUserId>&section=User_D_Prompt"
```

---

## 9. Gotchas (don't relearn these)

- **Server `main` is stale + has foreign WIP** → always worktree off `origin/main`.
- **Worktrees in `/tmp` get reaped** → put them under `/root/`.
- **`Havaya_App` dir vs `app.havaya` repo name** → use `-R cryptolir/app.havaya` for `gh`.
- **Never `npm run build` Havaya** (prisma migrate hits a real DB) → `tsc --noEmit` only.
- **Edit tool is local-only** → patch remote files via scp / Python scripts.
- **Nested SSH heredocs + `$(...)`/`$VAR` splitting break** → write a script to `/tmp`, run it.
- **Pre-commit hook env gaps** (`oxfmt`/formatters not installed) → `git commit --no-verify`.
- **Coolify (Havaya) and Cloud Run (dashboard) are operator-only** → after merge, ask the
  owner to redeploy.
- **Worktrees need `node_modules`** → symlink from the main checkout; `rm` the symlink
  before `git worktree remove`.
- **`deploy.sh` is whole-fleet** → for a single agent (e.g. `life`), pin its `docker.env`
  and `docker compose -p <agent> up -d openclaw-gateway` manually instead.
- **Forgetting STATUS.md** → it's the one doc that silently drifts; update it every session.

---
_Generated 2026-06-02. main HEADs at handover: openclaw `ba70447a1`,
openclaw-dashboard `61969a6`, app.havaya `3471686`. Companion: the Havaya-specific
`HANDOVER_HAVAYA_SESSION.md`._
