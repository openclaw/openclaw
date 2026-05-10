# AgentGlob Gateway Release Runbook

How to ship a new build of this repo (`openclaw` — the agent gateway/runtime)
to the AgentGlob production hosts on Hetzner.

> **Scope.** This runbook is for **AgentGlob gateway releases only** —
> the `openclaw-gateway` image that runs deployed agents on Hetzner.
>
> Do **not** confuse with [`docs/reference/RELEASING.md`](../reference/RELEASING.md),
> which covers npm / macOS distribution and is unrelated to gateway rollout.

---

## TL;DR

```bash
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245   # DevAgents server
/opt/openclaw-ops/scripts/build-and-push.sh           # builds + pushes from main, auto-tags
/opt/openclaw-ops/scripts/deploy.sh <tag> all         # rolls all agents on both hosts
```

Then verify:

```bash
ssh 1stclaw 'docker exec <agent-name>-openclaw-gateway-1 ls /opt/openclaw/skills/ | head'
```

---

## Where things live

| Thing                       | Location                                                                      |
| --------------------------- | ----------------------------------------------------------------------------- |
| Gateway repo (build source) | `root@204.168.223.245:/root/projects/openclaw`                                |
| Build script                | `/opt/openclaw-ops/scripts/build-and-push.sh` (on DevAgents)                  |
| Deploy script               | `/opt/openclaw-ops/scripts/deploy.sh` (on DevAgents)                          |
| Image registry              | `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway`   |
| EU prod host                | `1stclaw` (`89.167.70.46`) — SSH alias resolved via DevAgents `~/.ssh/config` |
| US prod host                | `2ndclaw` (`5.161.84.219`) — Docker auto-installs on first deploy             |
| Per-agent compose dir       | `/opt/openclaw` on each host                                                  |
| Per-agent env file          | `/root/.openclaw/agents/<agent-name>/docker.env` on each host                 |
| Tag format                  | `vYYYY.M.D.N` (or `vYYYY.M.D.N-hotfix`)                                       |

> **Important — operational scripts live outside this repo.** Both
> `build-and-push.sh` and `deploy.sh` live on the DevAgents server filesystem
> at `/opt/openclaw-ops/scripts/`, not under `openclaw/`. The "Script behavior
> snapshot" section below captures what they do at the time of writing so this
> runbook stays useful if the scripts are edited. **Re-verify against the
> actual scripts before doing a release.**

---

## Prerequisites

1. **DevAgents SSH access** with key `~/.ssh/hetzner-openclaw`
   (`id_ed25519` will not work — see `openclaw-dashboard/CLAUDE.md` §6).
2. **Code merged to `openclaw/main`** — `build-and-push.sh` runs
   `git checkout main && git pull --rebase origin main` before building.
   Feature branches that have not landed on `main` will not be in the image.
3. **Image registry auth** — `gcloud` is already configured on DevAgents for
   `europe-west1-docker.pkg.dev`. If a re-auth is needed:
   `gcloud auth configure-docker europe-west1-docker.pkg.dev`.
4. **SSH host aliases on DevAgents** — `1stclaw` and `2ndclaw` must resolve in
   `~/.ssh/config` on the DevAgents server. `deploy.sh` uses these names
   directly; bare IPs will not work.

---

## Step 1 — Build & push

Run on the **DevAgents** server:

```bash
ssh -i ~/.ssh/hetzner-openclaw root@204.168.223.245
/opt/openclaw-ops/scripts/build-and-push.sh                  # auto-tag (vYYYY.MM.DD.<next>)
# or pin a specific tag:
/opt/openclaw-ops/scripts/build-and-push.sh v2026.5.10.1
```

What this does:

1. Resolves a tag (auto: today's date + next sequence number, queried from
   Artifact Registry) or uses the one you passed.
2. `cd /root/projects/openclaw`, `git checkout main`, `git pull --rebase`.
3. `DOCKER_BUILDKIT=1 docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 -t <image>:<tag> -t <image>:latest .`
4. `docker push <image>:<tag>` and `<image>:latest`.
5. Prints the tag, source SHA, and the next-step API hints.

Skills are baked into the image: the Dockerfile does `COPY . .` and there is
no `skills` entry in `.dockerignore`, so whatever is in `openclaw/skills/`
on `main` at build time ends up at `/opt/openclaw/skills/` inside the
container. **There is no separate skill-shipping step.**

After this step finishes, register the release on the dashboard so the deploy
flow can reference it:

```
POST <DASHBOARD_BASE>/api/platform/releases       { tag: "<tag>", sourceSha: "<sha>" }
POST <DASHBOARD_BASE>/api/platform/releases/<tag>/promote     # promote to "stable"
```

(The build script prints these calls in its summary.)

---

## Step 2 — Deploy

Still on the **DevAgents** server:

```bash
/opt/openclaw-ops/scripts/deploy.sh <tag> all          # both hosts (default)
/opt/openclaw-ops/scripts/deploy.sh <tag> 1stclaw      # EU only
/opt/openclaw-ops/scripts/deploy.sh <tag> 2ndclaw      # US only
```

What this does, per host:

1. **Port-conflict check** — scans every agent's `docker.env` for duplicate
   `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_BRIDGE_PORT`. Fails fast if any clash.
2. **Pull image** — `docker pull <image>:<tag>` on the remote.
3. **Discover agents** — every directory under `/root/.openclaw/agents/`
   that has a `docker.env`.
4. **Roll one agent at a time** —
   - records the agent's current `OPENCLAW_IMAGE` for rollback,
   - warns if the image differs from the one being deployed,
   - `sed -i` updates `OPENCLAW_IMAGE` in the env file,
   - `docker compose -p <agent> --env-file <env> up -d openclaw-gateway`,
   - waits up to 15 s (3 × 5 s) for the container to reach `State.Status: running`,
   - rolls back on failure (sed back to previous image, `compose up` again).

> **Health-check limitation.** The check is purely `docker inspect`-based —
> "is the container running?" It does **not** HTTP-probe the gateway. A
> crash-looping process inside a still-running container may slip past.
> After deploy, do an explicit smoke-test (Step 3) before declaring success.

> **Compose error suppression.** `deploy.sh` runs the compose command with
> `|| true`, so a failed `compose up` does not abort the script. The
> only signal is the post-roll health check. Read the script's per-agent
> output carefully when something looks off.

---

## Step 3 — Verify

Two things to check after each release:

### 3a. Skills are present at the expected path

```bash
ssh -i ~/.ssh/hetzner-openclaw root@89.167.70.46 \
  'docker exec <agent-name>-openclaw-gateway-1 ls /opt/openclaw/skills/'
```

Should list every skill bundled in this build, including any newly added
ones (e.g. `rain` after the Rain skill ships).

### 3b. Smoke a deployed agent's runtime

For agents using AgentGlob platform integrations (wallet / Rain), call the
runtime endpoints from inside the container to confirm the bearer token and
URL injection landed correctly:

```bash
ssh -i ~/.ssh/hetzner-openclaw root@89.167.70.46
docker exec -it <agent-name>-openclaw-gateway-1 bash
# inside the container:
echo "$AGENTGLOB_RUNTIME_URL" "$AGENTGLOB_RUNTIME_TOKEN" | head -c 80; echo
curl -sS "$AGENTGLOB_RUNTIME_URL/api/runtime/wallet/balance?chain=arbitrum" \
  -H "Authorization: Bearer $AGENTGLOB_RUNTIME_TOKEN" | head
```

For Rain specifically, follow the smoke sequence in
[`openclaw-dashboard/docs/api/rain-runtime.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/docs/api/rain-runtime.md):

```bash
curl -sS "$AGENTGLOB_RUNTIME_URL/api/runtime/rain/markets?limit=3" \
  -H "Authorization: Bearer $AGENTGLOB_RUNTIME_TOKEN"
```

A `401 unknown bearer token` means the token in the env file does not match
any agent record — the agent was redeployed or the dashboard rotated the
token. Fix by re-running the per-agent dashboard deploy, **not** by editing
`docker.env` directly.

---

## Rollback

`deploy.sh` rolls each agent back automatically if the post-deploy health
check fails. Manual rollback to a previous tag is the same flow as forward
deploy:

```bash
/opt/openclaw-ops/scripts/deploy.sh <previous-tag> all
```

The script will detect the in-place image is different from `<previous-tag>`,
warn, then roll each agent back. Image history is in Artifact Registry:

```bash
gcloud artifacts docker tags list \
  europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway \
  --format='value(tag)' | sort | tail -10
```

---

## Hotfix lane

When prod is broken right now and the standard PR cycle is too slow:

1. Branch from the **current prod tag** in `openclaw`, not `main`:
   `git checkout v<current> -b hotfix/<desc>`
2. Apply the minimal fix (1–3 files), commit, push.
3. Merge to `main` immediately so the fix is not lost.
4. Build with an explicit `-hotfix` suffix:
   `/opt/openclaw-ops/scripts/build-and-push.sh v<current>.<n>-hotfix`
5. Deploy to the affected host(s) only:
   `/opt/openclaw-ops/scripts/deploy.sh <tag> 1stclaw`
6. Verify and confirm the broken-thing is fixed before promoting.

This mirrors the dashboard's hotfix lane (see
[`openclaw-dashboard/CLAUDE.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/CLAUDE.md) §2).

---

## Common failure modes

| Symptom                                                     | Likely cause                                                           | Fix                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `docker pull` fails on a host                               | gcloud auth on the host expired or the image isn't pushed yet          | Re-auth on the host, or wait for `build-and-push.sh` to complete the push               |
| Health check times out for one agent                        | Gateway crash-loop inside a "running" container                        | `docker logs <agent>-openclaw-gateway-1` on the host. Roll back if needed.              |
| `CONFLICT: Port X used by both '<a>' and '<b>'`             | Two agents reserved the same gateway/bridge port                       | Edit one agent's `docker.env` to a free port and redeploy that agent from the dashboard |
| Skill missing on host (`/opt/openclaw/skills/<name>` empty) | The skill was not on `main` at build time                              | Merge the skill PR, rebuild, redeploy                                                   |
| `401 unknown bearer token` at runtime                       | Dashboard rotated `gatewayToken`; container still has old one          | Re-run per-agent deploy from the dashboard so a new `docker.env` is written             |
| `403 source IP not on the Hetzner agent allowlist`          | Container egressing from a non-allowlisted IP (rare, network reconfig) | Verify host IP matches `lib/servers.ts` in the dashboard                                |

---

## Cross-references

- System architecture: [`openclaw-dashboard/AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/AGENTGLOB_SYSTEM_V1_ARCHITECTURE.md)
- Platform integrations (wallet/Rain activation policy): [`openclaw-dashboard/PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md)
- Rain runtime API contract: [`openclaw-dashboard/docs/api/rain-runtime.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/docs/api/rain-runtime.md)
- Dashboard release procedure (Cloud Run, separate from this): [`openclaw-dashboard/CLAUDE.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/CLAUDE.md) §1, §7

---

## Script behavior snapshot

Captured at the time of writing. **Re-verify against the live scripts before
each release.**

### `build-and-push.sh`

- Tag: arg `$1` if given, else auto `v$(date -u +%Y.%m.%d).<next-seq>` resolved from
  `gcloud artifacts docker tags list`.
- Pulls latest `main` via `git fetch && git checkout main && git pull --rebase`.
- `DOCKER_BUILDKIT=1 docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 -t <registry>:<tag> -t <registry>:latest .`
- Pushes both tags.
- Prints tag, source SHA, build timestamp, and "next steps" for release
  registration via the dashboard API.

### `deploy.sh`

- Args: `<tag>` (required), target `1stclaw | 2ndclaw | all` (default `all`).
- Per host: port-conflict check → image pull → per-agent roll with
  `docker compose -p <agent> --env-file <env> up -d openclaw-gateway`.
- Health: 3 × 5 s polling for `docker inspect --format='{{.State.Status}}' running`.
- Rollback: `sed -i` previous `OPENCLAW_IMAGE` back, `compose up -d` again.
- Compose errors are suppressed with `|| true` — only the health check
  decides success.
