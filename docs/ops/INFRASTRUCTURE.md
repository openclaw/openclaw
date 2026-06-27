# AgentGlob / OpenClaw — System Architecture & Infrastructure

**Last updated:** 2026-06-11 · **Status:** canonical living document · **Scope:** system architecture + all servers + GCP + edge.

> **This is the canonical system-architecture & design file for AgentGlob.** It is the single
> source of truth for how the system is built and run, and the index to every feature / process
> plan (§3). **Read it before you plan or deploy any new feature or capability, and update it
> — plus the plan it points to — as part of the same task.** The architecture _of record_ lives
> here; detailed designs live in the referenced plan docs and are summarised, not duplicated.
>
> The infra facts below are generated from a live read of every host (`docker ps`, `ss`,
> configs, ops scripts) plus GCP (`gcloud`) and public DNS. Where a fact is inferred rather
> than directly observed it is marked _(inferred)_. Keep this in sync after any
> architecture/fleet/topology change.

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

## 2. Application architecture (system of record)

> Folded in from `openclaw-dashboard/AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md` (the long-form V1
> design + rollout narrative, which remains the detailed reference). The architecture of record
> is here; that doc holds the full phase plans and the identity/Clerk write-up linked in §3.

**V1 goal.** A stable system where agents (1) chat reliably, (2) use platform-native
capabilities (wallet, Rain, …) through one shared runtime pattern, (3) deploy/redeploy with no
config drift, (4) are observable with fast rollback.

**Principles:** one deploy path · one secret model (`workspace_secrets`) · one runtime-auth
model for all `/api/runtime/*` routes · one integration pattern (skill + optional MCP +
secret-gated activation) · protocol/chain specifics live in dashboard runtime adapters, not in
agents.

### 2.1 Two planes

| Plane             | Repo / runtime                          | Responsibilities                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane** | `openclaw-dashboard` — Cloud Run (§5)   | Agent CRUD + deploy orchestration; Secrets (`workspace_secrets`); runtime auth (`lib/runtime-auth.ts`); runtime adapters — wallet (`/api/runtime/wallet/*`) and Rain (`/api/runtime/rain/*`); injects `AGENTGLOB_RUNTIME_URL` + `AGENTGLOB_RUNTIME_TOKEN` into each agent's `docker.env`. |
| **Data plane**    | `openclaw` gateway — Hetzner fleet (§6) | Gateway/chat execution; skill install + execution; per-agent isolation in `/root/.openclaw/agents/<agent>`; calls control-plane runtime routes for privileged ops (wallet/Rain).                                                                                                          |

The control-plane → data-plane wire is the same public `http(s)://<host-ip>:<agent-port>` +
gateway-token path documented in §9.

### 2.2 Canonical integration pattern (wallet, Rain, future)

1. Credential lives in **Secrets** — no per-feature credential CRUD.
2. Activation depends on the skill's **category** (below).
3. If active, deploy ensures the skill exists in the agent workspace and injects runtime
   URL/token env.
4. Agent skill calls `/api/runtime/<integration>/*`.
5. Dashboard route validates runtime auth (bearer token + allowlist) and runs adapter logic,
   returning explicit `400/401/403/502` errors.

Live today for **wallet** and **Rain**. A new native integration should need only these 5
steps — no custom credential storage.

| Category                                        | Source                                             | Activation                                                                                  |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **A — OpenClaw-bundled**                        | runtime image `/opt/openclaw/skills/`              | may be default-on per agent template                                                        |
| **B1 — workspace-shared** (`wallet`)            | `openclaw/skills/<name>` + `/api/runtime/<name>/*` | **loose** — workspace-secret presence activates for all agents in the workspace             |
| **B2 — per-agent** (`rain`, future `ostium`, …) | `openclaw/skills/<name>` + `/api/runtime/<name>/*` | **strict** — explicit per-agent selection required; secret presence alone does not activate |

Full activation matrix + required dashboard changes:
`openclaw-dashboard/PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md` §1a.

### 2.3 Identity & user management — 4-layer model

| #   | Layer               | Who                                                | Auth (today)                     | Store                                   |
| --- | ------------------- | -------------------------------------------------- | -------------------------------- | --------------------------------------- |
| 1   | Platform            | AgentGlob staff (`system_owner`, `platform_admin`) | NextAuth v5 JWT                  | Firestore `users`                       |
| 2   | Org / workspace     | Agent owners (`owner`, `admin`)                    | NextAuth v5 (Google + email/pw)  | `workspaces`, `workspace_members`       |
| 3   | Agent collaborators | `maintainer` / `operator` / `viewer`               | NextAuth (same session)          | `agent_role_assignments`                |
| 4   | **Bot members**     | Agents' end-users                                  | custom `jose` HS256 JWT + bcrypt | `bot_members*`, `channel_verifications` |

Layers 1–3 are stable. **Layer 4 is in PLAN:** move end-user auth to a managed IdP (Clerk, with
**Better Auth** as the OSS/self-hosted fallback) over a 6-phase rollout; NextAuth stays for
L1–3. **Three owner decisions are still open** — managed vs self-hosted, single Clerk instance
vs per-workspace keys, and the canonical `userId`. **Phase 3 (runtime trust / re-key) must
agree a canonical `userId` with the Havaya per-user-file plan** (§3) before the writer ships.
Full write-up: `openclaw-dashboard/AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md` → "Identity & user
management".

### 2.4 V1 contracts & acceptance

- **Deploy contract:** dashboard writes deterministic runtime env; redeploy preserves
  integration secrets; no per-agent manual edits for normal operation.
- **Runtime contract:** every privileged action goes through a runtime route with bearer token
  - allowlist; errors are explicit and user-safe.
- **Skill contract:** degrade gracefully on missing secret/auth and show actionable
  remediation ("set secret X", "redeploy agent").
- **Done when:** chat is stable across deploy/restart/redeploy; wallet + Rain share one
  activation+runtime pattern; a new native integration needs only the §2.2 pattern; failures
  are detectable with a rollback path. Remaining stability-hardening work (pre-deploy
  validation, boot health checks, auto-rollback on failed post-deploy health) is tracked as
  Phase 3 in the V1 doc.

---

## 3. Plans & feature docs (index)

> When you plan or ship a feature, **link its design/plan doc here and update the matching
> architecture section above.** Paths are repo-relative; `dash:` = `openclaw-dashboard`,
> `oc:` = `openclaw` (this repo).

**System & integrations**

- `dash:AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md` — long-form V1 design, rollout phases, task lanes, full identity/Clerk plan. _(summarised in §2)_
- `dash:PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md` — integration activation matrix + required dashboard changes. _(see §2.2)_
- `dash:HANDOVER_CLAUDE_SYSTEM_V1.md` — V1 status & cross-repo handover.

**Rain (B2 integration)**

- `dash:RAIN_V2_ARCHITECTURE.md` — Rain V2 design (largest plan).
- `dash:RAIN_INTEGRATION_PLAN.md` — integration steps.
- `dash:docs/api/rain-runtime.md` — Rain runtime API contract.
- `dash:docs/ops/rain-v1-cutover.md` — Rain V1 cutover checklist.
- `oc:docs/plans/rain-skill-rewrite.md` — Rain skill rewrite + create-market split.

**Wallet (B1 integration)**

- `dash:docs/api/wallet-runtime.md` — wallet runtime API.

**Identity (Layer 4) — PLAN**

- `dash:AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md` → "Identity & user management" — 4-layer model + Clerk/Better Auth rollout. _(summarised in §2.3)_

**Per-user memory / user-file**

- `oc:ops/graphiti-life/` — Graphiti per-user memory deploy + runbook. _(deployed; see §8)_
- `dash:docs/peruser-user-file-plan.md` / `dash:docs/peruser-user-file-asbuilt.md` — Havaya per-user user-file API.

**Skills & platform**

- `oc:docs/plans/canonical-skill-registry.md` — canonical skill registry.

**Group behavior**

- `dash:GROUP_BEHAVIOR_POLICY_PLAN.md` — bot-group model + group behavior policies + project coordination.

**Ops / release / status**

- `oc:docs/ops/agentglob-gateway-release.md` — gateway build/push/deploy/rollback. _(see §10)_
- `oc:STATUS.md` — current dev status · `oc:ROADMAP.md` · `oc:VISION.md`.

**Gateway internals (reference)**

- `oc:docs/concepts/architecture.md` — gateway architecture.
- `oc:docs/refactor/*` — clawnet, exec-host, plugin-sdk, strict-config, outbound-session-mirroring.

---

## 4. Hosts (Hetzner — SSH key `~/.ssh/hetzner-openclaw`)

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
resolve here). Havaya deploy: run `./deploy.sh patch|minor|major` on the dev server →
`git push origin main --follow-tags` → **GitHub webhook fires Coolify automatically** →
Coolify pulls + rebuilds. The Coolify deploy-webhook URL is a **manual force-redeploy
fallback** only — not the normal deploy path (uuid is a secret, stored in deploy config,
never in this repo). The Coolify install on the dev host is legacy/inactive — this is
the live one.

---

## 5. GCP layer (project `gold-verve-459312-e7`, number `296319693396`)

| Service                             | Type              | Region       | Endpoint / purpose                                                                                                                                      |
| ----------------------------------- | ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-dashboard`                | Cloud Run         | europe-west1 | **`app.agentglob.com`** — control UI, public chat API (`/api/public/chat/<agent>`), platform release API (`/api/platform/*`). Auto-deploys from source. |
| `agentglob-web`                     | Cloud Run         | us-central1  | `agentglob-web-296319693396.us-central1.run.app` — marketing/web.                                                                                       |
| `openclaw-gateway`                  | Artifact Registry | europe-west1 | Gateway images `gateway:vYYYY.MM.DD.N` (+ `:latest`). Pulled by the Hetzner agent hosts.                                                                |
| `cloud-run-source-deploy`, `gcr.io` | Artifact Registry | —            | Cloud Run source-deploy artifacts / legacy GCR.                                                                                                         |

**Edge:** `app.agentglob.com → 34.111.250.8` (Google Frontend, Next.js, cached — `x-nextjs-cache`).

---

## 6. Agent fleet (24 live gateways)

Each agent = its own `docker compose` project named after the agent. The gateway container
`<agent>-openclaw-gateway-1` listens on container port `18789` (WS), published to a unique
host port. Config lives at `/root/.openclaw/agents/<agent>/openclaw.json` with secrets in
`/root/.openclaw/agents/<agent>/docker.env`.

### EU (`89.167.70.46`) — 12 agents, all on `gateway:v2026.06.10.1`

`braveisrael, cashtronics, my-pa, mystory, onlyclaw, researcher, specy, stillasystems, testingbot, thebook, tzahi1, wellwell` (mikyhelper + kycbot deleted; a `main` agent dir exists with no running container)

### US (`5.161.84.219`) — 12 agents, all on `gateway:v2026.06.10.1` (drift resolved 2026-06-10); `life` pinned ahead on `gateway:v2026.06.27.1` (full per-user stack + deterministic memory recall: `app_profile` injection #68 + first-turn #71 + `load_skill` #74 + app-prompt slim v2026.06.20.3 + **memory-recall injection #90**, 2026-06-27; rollback `v2026.06.20.3` via `docker.env.bak.pre-v2026.06.27.1`)

`agentav, bob-the-project-manager, designer, familyorganizer, gems, jim-the-ceo, life, projectmanager, raingame, social-bob, thebook, vcode1bot` (productguy deleted 2026-06-10 — invalid bot token)

> `testingbot` (EU) is the safe smoke-test target (config-empty, no MCP deps).
> `life` (US) carries the per-user memory subsystem (§8).

---

## 7. Data stores

| Store                                                                     | Host         | Exposure                          | Purpose                                          |
| ------------------------------------------------------------------------- | ------------ | --------------------------------- | ------------------------------------------------ |
| **FalkorDB** (`graphiti-falkordb`, `falkordb/falkordb:latest`)            | US           | internal compose net only         | Graph + vector store behind Graphiti             |
| **Graphiti MCP** (`graphiti-mcp`, `zepai/knowledge-graph-mcp:standalone`) | US           | `172.17.0.1:8000` (host-internal) | Per-user agent memory server                     |
| **Postgres 16** (`havaya-postgres-dev`)                                   | Dev          | `:5432`                           | Havaya **dev** database                          |
| **MySQL** (host `mysqld`)                                                 | Dev          | `127.0.0.1:3306` / `:33060`       | dev database                                     |
| Per-agent session/transcript/user-file stores                             | each gateway | in-container                      | sessions, transcripts, `workspace/users/<id>.md` |

---

## 8. Integrations

Cross-system integrations: where an agent, the dashboard, and an external app are wired
together into one product. Architecture of record here; details live in the linked docs.

### 8.1 Havaya.me agent (`life`) — per-user memory (Graphiti) — US host

Gives the `life` agent durable, per-user memory across Telegram and the Havaya app. Full
deploy + runbook in `ops/graphiti-life/` (compose, proxy, hook,
tests); plan in `docs/experiments/plans/life-per-user-memory.md`.

```
life gateway ──(mcp-bridge)──► graphiti-proxy (capability boundary, stdio)
                                   └─HTTP→ graphiti-mcp :8000 ──► FalkorDB
```

- Stack: `/opt/graphiti` (compose project `graphiti-life`); `graphiti-mcp` bound to
  `172.17.0.1:8000` (never public). Reachability from `life` is **declarative**:
  `graphiti-mcp` joins the external `life_default` network in compose (PR #59) — the old
  imperative `docker network connect` did not survive container recreation and broke
  memory silently on 2026-06-10. `falkordb` stays internal-only.
- Per-user scope (`group_id = tg_<peer>` for Telegram DMs / `app_<appUserId>` for the app)
  is injected server-side by a `before_tool_call` typed hook (`life-memory-scope` plugin);
  the proxy hard-pins it, fails closed if absent, exposes only `add_memory` /
  `search_memory_facts` / `search_nodes` / `get_episodes`, and hides destructive tools.
- LLM/embedder: OpenAI (`gpt-4o-mini` + `text-embedding-3-small`), key from `life/docker.env`.
- Memory protocol prompt (Hebrew, TAL voice) in `life` `workspace/AGENTS.md`.
- Webchat sessions have no per-user identity → no memory scope (by design; test via
  Telegram or the app, not webchat).

### 8.2 Havaya app ↔ AgentGlob (agents + dashboard)

The Havaya app (`cryptolir/app.havaya` — Next.js + Clerk auth + own Postgres, served from
the Coolify host at `app.havaya.me`) is a **consumer of the AgentGlob public API**; the
`life` agent is its brain. As-built spec: `app.havaya` repo →
`AGENTGLOB_INTEGRATION_STATUS.md` (+ `ARCHITECTURE.md`).

```
Havaya app (Coolify) ──HTTPS──► dashboard /api/public/chat/life (Cloud Run)
   │   chat:      POST {message, sessionKey app:havaya:<clerkUserId>:<convId>, appUserId}
   │   user-file: GET  /user-file?userId=<clerkUserId>&section=… (Bearer AGENTGLOB_APP_API_KEY)
   ▼
dashboard ──ws/token──► life gateway (US host)
                          ├─ chat.send carries appUserId → persisted on the session
                          ├─ save_user_section tool → workspace/users/<clerkUserId>.md
                          └─ Graphiti memory scoped group_id = app_<clerkUserId>  (§8.1)
```

- **Chat:** browser → Havaya same-origin `/api/chat` proxy (Clerk auth, per-user rate
  limit, transcript mirrored in Havaya's own DB) → dashboard public chat API →
  `life` gateway. No CORS, no streaming on this route, 3 000-char message cap; the
  dashboard forwards `appUserId` into gateway `chat.send` (dashboard PR #108,
  gateway PR #49).
- **Per-user visible file (two directions, same file):** the agent writes via the
  `save_user_section` tool (allowlisted sections `User_D_Prompt`, `app_note`) into
  `workspace/users/<clerkUserId>.md` on the gateway; Havaya reads it back via the
  dashboard `GET …/user-file` endpoint (`lib/user-file-core.ts`, dashboard PR #107,
  app-key auth) to render the home-hub prompts panel + owner note. Lazy provisioning —
  404 until the agent first writes.
- **Identity, one id everywhere:** the Clerk `userId` is the canonical app identity —
  it keys the sessionKey, the user-file name (raw, lowercased) and the Graphiti memory
  scope `app_<id>`. Telegram users are a parallel scope (`tg_<peer>`); same human on
  both channels = two scopes in v1. Phase 5 (pending): generalize `save_user_section`
  to the canonical userId so Telegram users also get a visible file.
- **Not synced with the dashboard UI:** Havaya does not use dashboard threads/voice;
  it owns its UX and persists its own transcripts (the public chat API has no
  history-fetch).
- **Havaya marketing site** (`cryptolir/Havaya.me`) is a separate static Next.js site on
  the same Coolify host — no AgentGlob API usage; deploys per §4 (git push → Coolify).

---

## 9. Networking & ingress

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

## 10. CI/CD & deploy flow

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

## 11. Source repositories (on the dev host, GitHub org `cryptolir`)

| Path                                      | Repo                           | Purpose                                                                                                |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `/root/AgentGlob_Apps/openclaw`           | `cryptolir/openclaw`           | Worker / gateway / MCP (this repo); also the gateway image build tree (`build-and-push.sh` `REPO_DIR`) |
| `/root/AgentGlob_Apps/openclaw-dashboard` | `cryptolir/openclaw-dashboard` | Dashboard (Cloud Run)                                                                                  |
| `/root/projects/Havaya.me`                | `cryptolir/Havaya.me`          | Havaya marketing site                                                                                  |
| `/root/projects/Havaya_App`               | `cryptolir/app.havaya`         | Havaya app                                                                                             |
| `/root/projects/Panama-KYC`               | `cryptolir/Panama-KYC`         | KYC service (cf. `kycbot` agent)                                                                       |
| `/root/projects/Mn_agents`                | (no git remote)                | misc agent material                                                                                    |

> Moved 2026-06-11: `openclaw` + `openclaw-dashboard` live under `/root/AgentGlob_Apps/`
> (previously `/root/projects/`). The standalone `oc-gw-build` tree is retired —
> `build-and-push.sh` builds directly from `/root/AgentGlob_Apps/openclaw`.

---

## 12. Domains & DNS

| Domain                                | Resolves to            | Served by                                                  |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `app.agentglob.com`                   | `34.111.250.8`         | Cloud Run `openclaw-dashboard` (Google Frontend)           |
| `agentglob.com`                       | (no A record observed) | —                                                          |
| `havaya.me` / `www` / `app.havaya.me` | `178.104.184.3`        | **Coolify server** (hosts all AgentGlob web/apps + Havaya) |
| `agentglob-web-…run.app`              | Google                 | Cloud Run `agentglob-web`                                  |

---

## 13. Risks & open items

> **Ops changes 2026-06-10** (bug-list sweep — see `scripts/ops/bug_list.md` for full detail):
>
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
> - **channel-error-hardening delivered** (see docs/experiments/plans/channel-error-hardening.md
>   addendum): gateway terminal-error circuit (openclaw#58) rolled fleet-wide as
>   `v2026.06.10.1`; token validation at save (dashboard#115); hourly `gateway-watchdog.sh`
>   cron (:17) on both hosts; diagnostic restart-delta/log-rate checks. ⚠️ B3 resource caps
>   REVERTED — 1 GiB mem_limit OOM-cycled the EU fleet at boot; see compose comment before
>   retrying. Release `v2026.06.10.1` (sourceSha 5ad5cd10c) NOT yet registered via
>   /api/platform/releases (manual dashboard step).
> - `diagnostic-cron.sh` now archives stale `*.bak` / `.archive-*` (>7 days) from
>   `/opt/openclaw` on both hosts into `/root/openclaw-cruft-archive/<date>/` (never deletes;
>   `soul.md` + `status/` untouched — soul.md seeds new agents' SOUL.md at deploy).

1. **RAM pressure:** EU `~7.5/7.6 GiB` near saturation. US relieved by the 2026-06-10 sweep
   (~3.4 GiB available after stopping the productguy loop + fixing the mcp-bridge crash-loops +
   full recreate); watch the daily AUTOSCAN — rescale only if `swap_used` stays >1 GiB. The
   US Graphiti stack still adds load on the smallest box (2 vCPU).
2. **Image drift on US — RESOLVED 2026-06-10:** fleet unified on `gateway:v2026.06.10.1`
   (terminal-error circuit release). Superseded text: `designer`, `agentav`, `gems` run a **stale local image
   `openclaw:v2026.05.05.1`** (not from the registry); `raingame` `v2026.05.24.2`; `life`
   `v2026.06.01.1`; the rest `v2026.05.24.1`. EU is uniform on `v2026.05.24.1`. The fleet is
   not on a single version. **Disk (2026-06-18):** the host hit 97% (12 stacked gateway tags) mid-roll; freed 22 GB via `docker rmi` of 8 unused registry tags (verified no container ref; all re-pullable from Artifact Registry). Each roll adds ~8.5 GB - prune unused tags when rolling.
3. **`thebook` runs on BOTH EU and US** — same agent name on two hosts (telegram token not set
   in either config). Confirm which is canonical; a duplicate could double-answer or go stale.
4. **Coolify server `178.104.184.3`** hosts all AgentGlob web/apps + Havaya — a fourth host
   outside the agent fleet. Document its access (SSH/creds), backups, and resourcing; the dev
   host's Coolify is legacy/inactive and should not be confused with it.
5. **Agents publicly exposed** on `0.0.0.0:1879x`, protected only by the gateway token — no
   network-level allowlist / proxy in front.
6. **Single SSH key** (`~/.ssh/hetzner-openclaw`) for all hosts.

---

## 14. Operator quick-reference

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
