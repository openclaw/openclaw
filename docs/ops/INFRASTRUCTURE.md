# AgentGlob / OpenClaw — Infrastructure Map

**Last updated:** 2026-06-05 · **Status:** living document · **Scope:** all servers + GCP + edge.

> Generated from a live read of every host (`docker ps`, `ss`, configs, ops scripts) plus
> GCP (`gcloud`) and public DNS. Where a fact is inferred rather than directly observed it
> is marked _(inferred)_. Keep this in sync after fleet/topology changes.

---

## 1. Topology at a glance

```
                         ┌──────────── GCP project gold-verve-459312-e7 (#296319693396) ────────────┐
  app.agentglob.com ──► 34.111.250.8 (Google Frontend / GCLB)
                         │  Cloud Run: openclaw-dashboard (europe-west1)  → app.agentglob.com
                         │             • dashboard UI + /api/public/chat/<agent> + /api/platform/*
                         │  Cloud Run: agentglob-web      (us-central1)   → marketing/web
                         │  Artifact Registry: openclaw-gateway (gateway:vYYYY.MM.DD.N images)
                         └──────────────────────────────────────────────────────────────────────────┘
                                    │ dashboard → agent gateways over public IP:port + gateway token
        ┌───────────────────────────┼───────────────────────────────────────────────┐
        ▼                           ▼                                                 ▼
  DEV / BUILD                 EU PROD  (ssh alias 1stclaw)                     US PROD (ssh alias 2ndclaw)
  204.168.223.245             89.167.70.46                                     5.161.84.219
  8 vCPU / 30G / 226G         4 vCPU / 7.6G / 75G                              2 vCPU / 7.6G / 75G
  • builds gateway images     • 12 agent gateways                              • 12 agent gateways
  • all source repos          • uniform image v2026.05.24.1                    • + graphiti-life (Graphiti + FalkorDB)
  • dev DBs (pg + mysql)      • RAM ~99% used ⚠                               • RAM ~94% used ⚠ · image drift ⚠

  havaya.me / app.havaya.me ──► 178.104.184.3  (COOLIFY server — hosts all AgentGlob web/apps + Havaya)
```

---

## 2. Hosts (Hetzner — SSH key `~/.ssh/hetzner-openclaw`)

| Role            | IP                | SSH alias¹           | Specs            | Disk         | Uptime | What runs                                                                                                        |
| --------------- | ----------------- | -------------------- | ---------------- | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------- |
| **Dev / Build** | `204.168.223.245` | — (run scripts here) | 8 vCPU · 30 GiB  | 226 GB (81%) | ~67 d  | Gateway image builds, all git repos, dev Postgres + MySQL, 1 dev agent `main`. Coolify present but **inactive**. |
| **EU Prod**     | `89.167.70.46`    | `1stclaw` (default)  | 4 vCPU · 7.6 GiB | 75 GB (44%)  | ~98 d  | 12 production agent gateways. **RAM ~7.5/7.6 GiB.**                                                              |
| **US Prod**     | `5.161.84.219`    | `2ndclaw`            | 2 vCPU · 7.6 GiB | 75 GB (61%)  | ~97 d  | 12 agent gateways + **Graphiti memory stack**. **RAM ~7.2/7.6 GiB.**                                             |

¹ Aliases `1stclaw`/`2ndclaw` are defined in the **dev host's** `~/.ssh/config` and used by `deploy.sh`. From a laptop, connect by IP with the key above.

All three Hetzner hosts run Ubuntu (Linux 6.8.x).

### Coolify server (production web / apps) — `178.104.184.3`

A separate **Coolify** host (not part of the Hetzner agent fleet, not the dev box). It hosts
**all AgentGlob-related websites and apps** — frontends tied to `cryptolir/openclaw` and
`cryptolir/openclaw-dashboard` — **and `havaya.me` / `www.havaya.me` / `app.havaya.me`** (all
resolve here). Havaya release path: dev (204.168.223.245) → git (`cryptolir/Havaya.me`, push to
`main`) → Coolify auto-deploy via webhook
`http://178.104.184.3:8000/api/v1/deploy?uuid=<REDACTED — stored in deploy config>&force=false`.
(Deploy-webhook uuid is a secret; not stored in this repo. The Coolify install on the dev
host is legacy/inactive — this is the live one.)

---

## 3. GCP layer (project `gold-verve-459312-e7`, number `296319693396`)

| Service                             | Type              | Region       | Endpoint / purpose                                                                                                                                      |
| ----------------------------------- | ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-dashboard`                | Cloud Run         | europe-west1 | **`app.agentglob.com`** — control UI, public chat API (`/api/public/chat/<agent>`), platform release API (`/api/platform/*`). Auto-deploys from source. |
| `agentglob-web`                     | Cloud Run         | us-central1  | `agentglob-web-296319693396.us-central1.run.app` — marketing/web.                                                                                       |
| `openclaw-gateway`                  | Artifact Registry | europe-west1 | Gateway images `gateway:vYYYY.MM.DD.N` (+ `:latest`). Pulled by the Hetzner agent hosts.                                                                |
| `cloud-run-source-deploy`, `gcr.io` | Artifact Registry | —            | Cloud Run source-deploy artifacts / legacy GCR.                                                                                                         |

**Edge:** `app.agentglob.com → 34.111.250.8` (Google Frontend, Next.js, cached — `x-nextjs-cache`).

---

## 4. Agent fleet (24 live gateways)

Each agent = its own `docker compose` project named after the agent. The gateway container
`<agent>-openclaw-gateway-1` listens on container port `18789` (WS), published to a unique
host port. Config lives at `/root/.openclaw/agents/<agent>/openclaw.json` with secrets in
`/root/.openclaw/agents/<agent>/docker.env`.

### EU (`89.167.70.46`) — 12 agents, all on `gateway:v2026.05.24.1`

`braveisrael, cashtronics, my-pa, mystory, onlyclaw, researcher, specy, stillasystems, testingbot, thebook, tzahi1, wellwell` (mikyhelper + kycbot deleted; a `main` agent dir exists with no running container)

### US (`5.161.84.219`) — 12 agents (image versions vary — see §10)

`agentav, bob-the-project-manager, designer, familyorganizer, gems, jim-the-ceo, life, projectmanager, raingame, social-bob, thebook, vcode1bot` (productguy deleted 2026-06-10 — invalid bot token)

> `testingbot` (EU) is the safe smoke-test target (config-empty, no MCP deps).
> `life` (US) carries the per-user memory subsystem (§6).

---

## 5. Data stores

| Store                                                                     | Host         | Exposure                          | Purpose                                          |
| ------------------------------------------------------------------------- | ------------ | --------------------------------- | ------------------------------------------------ |
| **FalkorDB** (`graphiti-falkordb`, `falkordb/falkordb:latest`)            | US           | internal compose net only         | Graph + vector store behind Graphiti             |
| **Graphiti MCP** (`graphiti-mcp`, `zepai/knowledge-graph-mcp:standalone`) | US           | `172.17.0.1:8000` (host-internal) | Per-user agent memory server                     |
| **Postgres 16** (`havaya-postgres-dev`)                                   | Dev          | `:5432`                           | Havaya **dev** database                          |
| **MySQL** (host `mysqld`)                                                 | Dev          | `127.0.0.1:3306` / `:33060`       | dev database                                     |
| Per-agent session/transcript/user-file stores                             | each gateway | in-container                      | sessions, transcripts, `workspace/users/<id>.md` |

---

## 6. Per-user memory subsystem (Graphiti) — US host

Gives the `life` agent durable, per-user memory. Full deploy + runbook in
[`ops/graphiti-life/`](../../ops/graphiti-life/) (compose, proxy, hook, tests).

```
life gateway ──(mcp-bridge)──► graphiti-proxy (capability boundary, stdio)
                                   └─HTTP→ graphiti-mcp :8000 ──► FalkorDB
```

- Stack: `/opt/graphiti` (compose project `graphiti-life`); `graphiti-mcp` bound to
  `172.17.0.1:8000` (never public); `life` container joined to the `graphiti-life_graphiti`
  network so it resolves `graphiti-mcp` by name.
- Per-user scope (`tg_<peer>` / `app_<appUserId>`) is injected server-side by a
  `before_tool_call` typed hook; the proxy hard-pins it and hides destructive tools.
- LLM/embedder: OpenAI (`gpt-4o-mini` + `text-embedding-3-small`), key from `life/docker.env`.

---

## 7. Networking & ingress

- **Public chat / control:** browser/app → `app.agentglob.com` (Cloud Run dashboard) → the
  dashboard connects to the target agent's gateway at **`http(s)://<host-ip>:<agent-port>`**
  authenticated with that agent's **gateway token** (`gateway.auth.token` in its `openclaw.json`).
- **Agent gateway ports:** published on `0.0.0.0:1879x–188xx` per host (so the Cloud Run
  service can reach them). Port numbers are unique per host; the same number may be reused
  across the two hosts without conflict. Full map in the Appendix.
- **Graphiti:** reachable only on the docker bridge / its compose network — not internet-facing.
- **No reverse proxy** (nginx/caddy/traefik all inactive) on the Hetzner hosts; ingress is
  direct IP:port + token.

---

## 8. CI/CD & deploy flow

**Dashboard / web (Cloud Run):** auto-deploy from source on merge (`cloud-run-source-deploy`).

**Gateway image (manual, from the dev host):**

```bash
# 1) build + push (auto-tags vYYYY.MM.DD.N from Artifact Registry, also tags :latest)
/opt/openclaw-ops/scripts/build-and-push.sh            # builds from /root/projects/oc-gw-build
# 2) register + promote the release (platform API on the dashboard)
#    POST /api/platform/releases { tag, sourceSha } ; POST /api/platform/releases/<tag>/promote
# 3) roll to a fleet
/opt/openclaw-ops/scripts/deploy.sh <tag> 1stclaw      # EU
/opt/openclaw-ops/scripts/deploy.sh <tag> 2ndclaw      # US
/opt/openclaw-ops/scripts/deploy.sh <tag> all          # both
```

`deploy.sh` is **per-agent rolling**: pulls the image, then for each agent updates
`OPENCLAW_IMAGE` in its `docker.env`, `docker compose -p <agent> up -d openclaw-gateway`,
health-checks the container (3 retries), and **auto-rolls-back** to the previous image on
failure. `check-ports.sh` validates port hygiene. Registry:
`europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway`.

### Deploy protocol — git + docs sync is MANDATORY

> A production deploy is **not complete** until the change is in git **and** the project
> docs/memory reflect it. "Changed on a host but not in git" is an incident to reconcile,
> not a normal state.

Every prod change — gateway image, agent `openclaw.json` / `docker.env`, extensions, hooks,
prompts (`AGENTS.md` etc.), or infra/compose (`/opt/...`) — must, **as part of the same task**:

1. **Commit + push** the code/config/infra to the relevant repo + PR (never leave prod
   changes only on the host). Host-side configs that can't be committed verbatim (secrets)
   are mirrored as redacted records under `ops/`.
2. **Update the docs this affects** — this file (`INFRASTRUCTURE.md`), the relevant
   plan/`STATUS`, and any agent prompt/config records under `ops/`.
3. **Record the release** (tag + `sourceSha` via the platform release API) where applicable.
4. **Keep a host-side backup** of any edited config (`*.bak.pre-<change>`) for rollback.

---

## 9. Source repositories (on the dev host, GitHub org `cryptolir`)

| Path                                | Repo                           | Purpose                            |
| ----------------------------------- | ------------------------------ | ---------------------------------- |
| `/root/projects/openclaw`           | `cryptolir/openclaw`           | Worker / gateway / MCP (this repo) |
| `/root/projects/oc-gw-build`        | `cryptolir/openclaw`           | Gateway image build tree           |
| `/root/projects/openclaw-dashboard` | `cryptolir/openclaw-dashboard` | Dashboard (Cloud Run)              |
| `/root/projects/Havaya.me`          | `cryptolir/Havaya.me`          | Havaya marketing site              |
| `/root/projects/Havaya_App`         | `cryptolir/app.havaya`         | Havaya app                         |
| `/root/projects/Panama-KYC`         | `cryptolir/Panama-KYC`         | KYC service (cf. `kycbot` agent)   |
| `/root/projects/Mn_agents`          | (no git remote)                | misc agent material                |

---

## 10. Domains & DNS

| Domain                                | Resolves to            | Served by                                                  |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `app.agentglob.com`                   | `34.111.250.8`         | Cloud Run `openclaw-dashboard` (Google Frontend)           |
| `agentglob.com`                       | (no A record observed) | —                                                          |
| `havaya.me` / `www` / `app.havaya.me` | `178.104.184.3`        | **Coolify server** (hosts all AgentGlob web/apps + Havaya) |
| `agentglob-web-…run.app`              | Google                 | Cloud Run `agentglob-web`                                  |

---

## 11. Risks & open items

> **Ops changes 2026-06-10** (bug-list sweep — see `scripts/ops/bug_list.md` for full detail):
> - **US docker daemon** now has `/etc/docker/daemon.json` with json-file rotation (10m×3) +
>   `live-restore` (same as EU); all 12 US agent containers recreated so rotation is live.
>   ⚠️ Staging rule learned the hard way: recreate/boot gateways in batches of ~3 on the
>   2-vCPU US host — 12 simultaneous node boots drove load to 117 and stalled sshd.
> - **mcp-bridge plugin v1.0.1** (EPIPE hardening) deployed to canonical + all per-agent
>   copies on both hosts (`.bak.pre-epipe-fix` kept). Source of truth is now
>   `openclaw-dashboard` `assets/mcp-bridge/` (PR #114); `ensureMcpBridgePlugin` converges
>   host copies by sha. The canonical extension (`/root/.openclaw/extensions/mcp-bridge`)
>   now ships `mcp-server-filesystem`, `mcp-server-brave-search`, and `exa-mcp-server@3.1.9`
>   as real package.json deps. Hosts have no npm — bootstrap/update via a one-off container:
>   `docker run --rm --entrypoint sh -e HOME=/tmp -v /root/.openclaw/extensions/mcp-bridge:/work -w /work <gateway-image> -c 'npm install …'`
>   then `chown -R 1000:1000` the dir.
> - **productguy (US) deleted 2026-06-10** (invalid Telegram token, 401 loop — stopped first,
>   then removed by owner; verified no container/dir/volume remnants). US fleet = 12 agents.
> - `diagnostic-cron.sh` now archives stale `*.bak` / `.archive-*` (>7 days) from
>   `/opt/openclaw` on both hosts into `/root/openclaw-cruft-archive/<date>/` (never deletes;
>   `soul.md` + `status/` untouched — soul.md seeds new agents' SOUL.md at deploy).

1. **RAM pressure:** EU `~7.5/7.6 GiB` near saturation. US relieved by the 2026-06-10 sweep
   (~3.4 GiB available after stopping the productguy loop + fixing the mcp-bridge crash-loops +
   full recreate); watch the daily AUTOSCAN — rescale only if `swap_used` stays >1 GiB. The
   US Graphiti stack still adds load on the smallest box (2 vCPU).
2. **Image drift on US:** `designer`, `agentav`, `gems` run a **stale local image
   `openclaw:v2026.05.05.1`** (not from the registry); `raingame` `v2026.05.24.2`; `life`
   `v2026.06.01.1`; the rest `v2026.05.24.1`. EU is uniform on `v2026.05.24.1`. The fleet is
   not on a single version.
3. **`thebook` runs on BOTH EU and US** — same agent name on two hosts (telegram token not set
   in either config). Confirm which is canonical; a duplicate could double-answer or go stale.
4. **Coolify server `178.104.184.3`** hosts all AgentGlob web/apps + Havaya — a fourth host
   outside the agent fleet. Document its access (SSH/creds), backups, and resourcing; the dev
   host's Coolify is legacy/inactive and should not be confused with it.
5. **Agents publicly exposed** on `0.0.0.0:1879x`, protected only by the gateway token — no
   network-level allowlist / proxy in front.
6. **Single SSH key** (`~/.ssh/hetzner-openclaw`) for all hosts.

---

## 12. Operator quick-reference

```bash
# SSH (laptop)
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245   # dev/build
ssh -i ~/.ssh/hetzner-openclaw root@89.167.70.46      # EU prod
ssh -i ~/.ssh/hetzner-openclaw root@5.161.84.219      # US prod

# Agent logs
docker logs <agent>-openclaw-gateway-1 --tail 50

# Public chat smoke (safe target: testingbot)
curl -sS -X POST 'https://app.agentglob.com/api/public/chat/testingbot' \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with exactly: smoke-ok","sessionKey":"smoke-test"}'

# Graphiti (US host)
cd /opt/graphiti && docker compose ps && ./smoke.sh
```

---

## Appendix A — agent → host-port map

`<host-port> → 18789` (container WS). Ports are per-host.

**EU (`89.167.70.46`):** braveisrael 18803 · kycbot 18799 · mikyhelper 18793 · my-pa 18811 ·
mystory 18807 · onlyclaw 18805 · researcher 18829 · specy 18819 · stillasystems 18825 ·
testingbot 18817 · thebook 18809 · tzahi1 18821 · wellwell 18823

**US (`5.161.84.219`):** agentav 18809 · bob-the-project-manager 18793 · designer 18807 ·
familyorganizer 18803 · gems 18815 · jim-the-ceo 18797 · life 18813 ·
projectmanager 18789–18790 · raingame 18811 · social-bob 18791 · thebook 18801 · vcode1bot 18799
