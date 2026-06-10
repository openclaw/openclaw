# Handover — Working on this server from your Mac (AgentGlob: openclaw + openclaw-dashboard)

> **Purpose:** open a fresh session on your Mac and do all real work **on this
> dev server**, where both repos are already checked out, installed, and built.
> Last updated 2026-06-10.

---

## 1. The server

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Hostname     | `DevAgents`                                    |
| Public IPv4  | `204.168.223.245`                              |
| IPv6         | `2a01:4f9:c014:bf10::1`                        |
| SSH user     | `root`                                         |
| SSH port     | `22` (sshd listening on all interfaces)        |
| OS           | Ubuntu 24.04.4 LTS                             |
| Tooling      | node `v22.22.3`, pnpm `10.33.0`, npm `11.16.0` |
| Project root | `/root/AgentGlob_Apps`                         |

> Note: this same box also holds unrelated checkouts under `/root/projects`
> (Havaya, `oc-gw-build`, etc.). **This project lives only under
> `/root/AgentGlob_Apps`** — ignore the older `HANDOVER_DEV_SERVER.md` files
> inside each repo; their `/root/projects/openclaw*` paths are stale.

---

## 2. One-time Mac setup

### a. Add your Mac's public key to the server (if not already done)

From your Mac:

```bash
# Generate a key if you don't have one:
ssh-keygen -t ed25519 -C "your-mac" -f ~/.ssh/agentglob-dev

# Copy it to the server (uses an existing password/key login once):
ssh-copy-id -i ~/.ssh/agentglob-dev.pub root@204.168.223.245
```

### b. Add an SSH config alias (`~/.ssh/config` on your Mac)

```sshconfig
Host DevAgents
    HostName 204.168.223.245
    User root
    Port 22
    IdentityFile ~/.ssh/agentglob-dev
    ServerAliveInterval 30
    ServerAliveCountMax 4
```

After this, `ssh DevAgents` just works.

---

## 3. Connect & start working

```bash
ssh DevAgents
cd /root/AgentGlob_Apps
```

You can also drop straight into the project:

```bash
ssh -t DevAgents 'cd /root/AgentGlob_Apps && exec bash'
```

**Editor / agent options:**

- **VS Code / Cursor Remote-SSH:** connect to host `DevAgents`, open folder
  `/root/AgentGlob_Apps`. Edits run on the server.
- **Claude Code:** run it on the server inside `/root/AgentGlob_Apps` over the
  SSH session.

---

## 3b. Read BEFORE writing any code

Each repo declares mandatory onboarding docs. Read the ones for the repo you're
touching first:

**openclaw** (`/root/AgentGlob_Apps/openclaw`)

- `AGENTS.md` — entry doc (= `CLAUDE.md`, which is a symlink to it). Project
  structure, channel/plugin rules, conventions.
- `MULTI_AGENT_PROTOCOL.md` — branch ownership, handoff & conflict rules.
- `STATUS.md` — current project state; **check before branching, update at session end.**
- `CONTRIBUTING.md`, `ROADMAP.md`, `VISION.md` — as needed.

**openclaw-dashboard** (`/root/AgentGlob_Apps/openclaw-dashboard`)

- `CLAUDE.md` — **"read before writing a single line of code"**: mandatory
  release pipeline (branch → typecheck+build → PR → squash-merge → auto-deploy),
  hotfix lane, manual-deploy fallback. Auto-loaded by Claude Code at session start.
- `AGENTS.md` — Codex instructions + multi-agent coordination rules.
- `DEVSETUP.md` — local/dev setup.
- `AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md`, `PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md`,
  `RAIN_V2_ARCHITECTURE.md` — system architecture references.

> The dashboard's `AGENTS.md` points at the gateway's `MULTI_AGENT_PROTOCOL.md`
> and `STATUS.md` as `../openclaw/...` — i.e. `/root/AgentGlob_Apps/openclaw/`,
> the sibling checkout.

---

## 4. The two repos (source of truth = GitHub `cryptolir/*`, branch `main`)

| Repo                           | On-disk                                   | Stack / tooling                   | Install        | Dev                        |
| ------------------------------ | ----------------------------------------- | --------------------------------- | -------------- | -------------------------- |
| `cryptolir/openclaw` (gateway) | `/root/AgentGlob_Apps/openclaw`           | pnpm monorepo, TypeScript, vitest | `pnpm install` | see `package.json` scripts |
| `cryptolir/openclaw-dashboard` | `/root/AgentGlob_Apps/openclaw-dashboard` | Next.js 15, npm                   | `npm ci`       | `npm run dev`              |

Both push over SSH (`git@github.com:cryptolir/*`), so the server needs a GitHub
deploy/SSH key — already configured here.

Quick gate before pushing:

- **openclaw:** `pnpm install && pnpm -s exec tsc --noEmit && pnpm test` (use the
  repo's actual lint/test scripts in `package.json`).
- **dashboard:** `npm ci && npx tsc --noEmit && npm run build` (mirrors CI in
  `.github/workflows/deploy.yml`).

---

## 5. ⚠️ Deployment — push to `main` = production deploy

| Repo                 | Trigger                                                                             | Goes to                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-dashboard` | **any** push to `main` (`deploy.yml`, no path filter — even docs-only)              | Google Cloud Run, project `gold-verve-459312-e7`, region `europe-west1`, service `openclaw-dashboard` → `https://app.agentglob.com`. Auto-tags `vYYYY.M.D.N`.             |
| `openclaw`           | push to `main` or `v*` tag (`docker-release.yml`; `*.md`/docs/skills paths ignored) | multi-arch images to `ghcr.io/cryptolir/openclaw` (`main-amd64`, `latest-amd64`, version tags). Run targets: `fly.toml` (app `openclaw`, region `iad`) and `render.yaml`. |

**Safe-commit habit:** commit locally and review before pushing. A push is a
production action — don't push a dirty/experimental tree to `main`.

Gateway runtime port (when running): `18789` (currently not listening).
Dashboard talks to the gateway at `89.167.70.46:18789` per `cloudbuild.yaml`.

---

## 6. Current state (2026-06-10)

| Repo               | `main` HEAD                                 | Working tree                                                                                                                                                                        |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openclaw           | `bc372b4ed` (ops: v2026.06.10.1 fleet roll) | **clean**                                                                                                                                                                           |
| openclaw-dashboard | `643d33a` (fix(deploy) #113)                | `AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md` modified — a Clerk/Layer-4 identity plan section, **uncommitted on purpose**. Commit it when ready (will trigger a Cloud Run deploy on push). |

---

## 7. Gotchas

- Server's local `main` can drift; always `git fetch origin` first.
- openclaw = **pnpm**, dashboard = **npm**. Don't cross them.
- A dashboard push deploys even for markdown-only changes (no path filter).
- The per-repo `HANDOVER_DEV_SERVER.md` files predate this checkout layout —
  trust this note for paths.
