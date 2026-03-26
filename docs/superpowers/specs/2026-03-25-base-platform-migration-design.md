# Base Platform Migration — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Author:** Jeff + Claude
**Sub-Project:** 1 of 5 (Fleet Migration)

## Problem

The fleet runs a custom Python-based OpenClaw fork (v0.1.0, commit b7d1363) with 11 custom capabilities on 4 active nodes over Tailscale. Upstream OpenClaw (v2026.3.24) is a Node.js/TypeScript gateway with 82 extensions, built-in Telegram/Discord/WhatsApp channels, Tailscale-native networking, node pairing, and a plugin SDK. The fork's base is so far behind upstream that incremental patching is impractical. A clean upstream installation is needed before any custom capabilities can be ported.

**The "home" / Old VPS node (100.85.159.3) is decommissioned as of 2026-03-22 and excluded from all migration work.**

## Goal

Get upstream OpenClaw v2026.3.24 running on all 4 active fleet nodes (Gateway, Kubuntu, Pop!_OS, Mac) with:

- Telegram channel connected and responding to the owner
- Anthropic and Ollama LLM providers configured
- Gateway reachable from all nodes over Tailscale
- Existing services (Supabase, Archon, Ollama, fleet-redis) unaffected
- Old fork preserved and restartable as fallback

This spec does NOT cover custom plugin porting, the 27-tool agentic bot, or any capability beyond what upstream provides out of the box.

## Solution

Install upstream OpenClaw via Docker on all nodes, with the Gateway VPS running `openclaw gateway` as the single brain and the other nodes running as paired clients. Use Ansible to deploy configuration and manage the lifecycle. Map existing SOPS-encrypted secrets into upstream's `openclaw.json` config format.

---

## 1. Installation Strategy

### Decision: Docker on all nodes

Upstream provides a production-grade `docker-compose.yml` with health checks, volume mounts, and a multi-stage Dockerfile. Running OpenClaw in Docker is the right choice because:

- It matches the existing deployment model (every node already runs Docker services)
- It isolates OpenClaw from host Node.js versions
- The Dockerfile supports build-time extension selection via `OPENCLAW_EXTENSIONS`
- Ansible can manage Docker containers consistently across all nodes

The alternative (npm global install or bare source) would introduce Node.js version management burden on Linux nodes where Node.js is not currently installed.

### Build strategy

Build the Docker image on the Mac dev workstation and push to a private registry (or build on each node). The image needs these extensions baked in:

```
OPENCLAW_EXTENSIONS="telegram ollama anthropic"
```

Additional extensions (brave, duckduckgo, etc.) can be added later but are not required for the base platform.

### Per-node installation

| Node | Action | Notes |
|------|--------|-------|
| **Mac** | `docker compose up -d openclaw-gateway` | Dev workstation, local testing first |
| **Gateway VPS** | Ansible deploys image + compose override | Production gateway, Telegram channel runs here |
| **Kubuntu** | Ansible deploys image + compose override | Node mode (connects to Gateway WS), Ollama provider |
| **Pop!_OS** | Ansible deploys image + compose override | Node mode (connects to Gateway WS) |

### Installation order

1. Mac — local development and validation
2. Gateway VPS — production gateway with Telegram
3. Kubuntu — first remote node, validates pairing flow
4. Pop!_OS — second remote node

---

## 2. Configuration Architecture

Upstream uses `~/.openclaw/openclaw.json` (JSON5) with strict schema validation. The Gateway watches the file for hot-reload. This replaces the old fork's `.env`-based configuration entirely for OpenClaw-specific settings.

### Gateway VPS config (`openclaw.json`)

```json5
{
  // Identity
  identity: {
    name: "OpenClaw",
    theme: "AI operations assistant",
  },

  // LLM providers
  auth: {
    profiles: {
      "anthropic:default": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:default"],
    },
  },

  // Agent defaults
  agent: {
    workspace: "~/.openclaw/workspace",
    model: { primary: "anthropic/claude-sonnet-4-6" },
  },

  // Gateway binding
  gateway: {
    bind: "tailnet",  // Listen on Tailscale IP (100.69.32.10)
    auth: {
      mode: "token",
      // token injected from OPENCLAW_GATEWAY_TOKEN env var
    },
  },

  // Telegram channel
  channels: {
    telegram: {
      enabled: true,
      // botToken injected from TELEGRAM_BOT_TOKEN env var
      dmPolicy: "allowlist",
      allowFrom: ["<jeff-telegram-id>"],
      groups: { "*": { requireMention: true } },
    },
  },

  // Logging
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
  },
}
```

### Node config (Kubuntu, Pop!_OS)

Nodes do NOT run the gateway service. They connect to the Gateway WS and register as paired nodes. Node-specific config is minimal:

```json5
{
  // No gateway block — this is a node, not a gateway
  // No channels block — channels are gateway-only
}
```

Nodes connect via the pairing flow (`openclaw nodes pair`) or by setting `OPENCLAW_GATEWAY_URL` to `ws://100.69.32.10:18789`.

### Ollama provider config (Kubuntu only)

The Ollama extension reads `OLLAMA_HOST` (or defaults to `http://localhost:11434`). Since Ollama runs on Kubuntu natively, the Kubuntu node's Docker compose needs:

```yaml
environment:
  OLLAMA_HOST: "http://host.docker.internal:11434"
```

The Gateway can route to Ollama models via the Kubuntu node's capabilities once paired.

---

## 3. Ansible Playbook Modifications

### New role: `openclaw_upstream`

Create a new Ansible role rather than modifying the existing `openclaw_node` / `openclaw_gateway` roles. This preserves rollback capability (the old roles still work with the fork).

**Role tasks:**

1. Create config directory: `~/.openclaw/` (or `~/apps/openclaw-upstream/` on fleet nodes)
2. Template `openclaw.json` from Jinja2 (per-node variables)
3. Template `docker-compose.upstream.yml` from Jinja2 (per-node overrides)
4. Deploy secrets to `auth-profiles.json` (Anthropic API key, gateway token)
5. Pull or build the Docker image
6. Start the container via `docker compose -f docker-compose.upstream.yml up -d`
7. Wait for health check (`/healthz` on port 18789)

### New playbook: `upstream.yml`

```yaml
---
- name: Deploy upstream OpenClaw (gateway)
  hosts: gateway
  roles:
    - openclaw_upstream
  vars:
    openclaw_mode: gateway

- name: Deploy upstream OpenClaw (nodes)
  hosts: nodes
  roles:
    - openclaw_upstream
  vars:
    openclaw_mode: node
```

### Inventory changes

Add per-host variables for upstream OpenClaw:

| Variable | Gateway | Kubuntu | Pop!_OS | Mac |
|----------|---------|---------|---------|-----|
| `openclaw_mode` | `gateway` | `node` | `node` | `gateway` |
| `openclaw_upstream_root` | `/home/appbox/apps/openclaw-upstream` | `/home/jeff/apps/openclaw-upstream` | `/home/jeff/apps/openclaw-upstream` | `~/Dev_Projects/openclaw_upstream` |
| `openclaw_gateway_bind` | `tailnet` | n/a | n/a | `loopback` |
| `openclaw_telegram_enabled` | `true` | `false` | `false` | `false` |
| `openclaw_ollama_host` | n/a | `http://host.docker.internal:11434` | n/a | n/a |

### Existing playbooks remain untouched

The existing `gateway.yml`, `node.yml`, and `site.yml` playbooks continue to manage the old fork. This is intentional for the transition period.

---

## 4. Secrets Management

### Current state

SOPS-encrypted JSON files in `secrets/` directory, deployed as flat `.env` files via `sops-env.sh`. Keys relevant to upstream:

| Secret | Current env var | Upstream mapping |
|--------|----------------|-----------------|
| Anthropic API key | `ANTHROPIC_API_KEY` | `auth-profiles.json` or `ANTHROPIC_API_KEY` env var |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` in config or `TELEGRAM_BOT_TOKEN` env var |
| Gateway auth token | (new) | `OPENCLAW_GATEWAY_TOKEN` env var |
| Ollama API key | (none needed) | n/a (local, no auth) |

### Upstream secrets approach

Upstream OpenClaw reads secrets from three places (in priority order):

1. **Environment variables** — `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`
2. **`auth-profiles.json`** — provider credentials in `~/.openclaw/auth-profiles.json`
3. **Config file** — inline in `openclaw.json` (not recommended for secrets)

**Decision: Use environment variables for all secrets.** This aligns with the existing SOPS workflow. The `sops-env.sh` script will be extended with a new node name (`gateway-upstream`, `kubuntu-upstream`, etc.) that generates the env vars upstream expects.

### New SOPS encrypted file

Create `secrets/upstream-gateway.env.enc.json` with:

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "TELEGRAM_BOT_TOKEN": "123:abc...",
  "OPENCLAW_GATEWAY_TOKEN": "<generate-new-token>"
}
```

The gateway token is new — generate with `openssl rand -hex 32`. All nodes that connect to the Gateway must share this token.

---

## 5. Service Coexistence

Upstream OpenClaw must coexist with existing services on each node. The key constraint is port allocation and Docker network isolation.

### Gateway VPS service map

| Service | Port | Network | Status |
|---------|------|---------|--------|
| nginx | 443 | host | Stays unchanged |
| Supabase | 54321 | supabase-net | Stays unchanged |
| Archon | 8181 | openclaw-net | Stays unchanged |
| Archon UI | 3737 | openclaw-net | Stays unchanged |
| Archon MCP | 8051 | openclaw-net | Stays unchanged |
| AOP Server | 3010 | openclaw-net | Stays unchanged |
| Web Outpost | 8082 | openclaw-net | **Stays for now** (migrates later) |
| Old OpenClaw fork | (cron container) | openclaw-net | **Stopped** when upstream starts |
| **OpenClaw upstream** | **18789** | **upstream-net** | **New** |

### Key decisions

- **Separate Docker network:** Upstream OpenClaw runs on its own `upstream-net` bridge network. It does not need to reach Supabase, Archon, or other services directly (that comes in later sub-projects when plugins are ported).
- **Port 18789:** Upstream's default gateway port. No conflicts with existing services.
- **Port 18790:** Upstream's bridge port (for sandbox isolation). Reserve but do not expose initially.
- **nginx reverse proxy:** Add an `/upstream/` location block to expose the Gateway Control UI externally via HTTPS. This is optional for the base platform but useful for monitoring.

### Kubuntu service map

| Service | Port | Status |
|---------|------|--------|
| Ollama | 11434 | Stays unchanged |
| fleet-redis | 6380 | Stays unchanged |
| Old OpenClaw fork | (cron container) | **Stopped** when upstream starts |
| **OpenClaw upstream** | **18789** | **New** (node mode, no external binding needed) |

### Pop!_OS service map

| Service | Port | Status |
|---------|------|--------|
| Obsidian Organizer | 8888, 3008 | Stays unchanged |
| Knowledge API | 8890 | Stays unchanged |
| Old OpenClaw fork | (cron container) | **Stopped** when upstream starts |
| **OpenClaw upstream** | **18789** | **New** (node mode) |

### Transition approach

The old fork and upstream cannot run simultaneously on the same node (resource contention, potential Telegram bot token conflicts). The sequence is:

1. Stop old fork container: `docker compose -f docker-compose.yml stop openclaw`
2. Start upstream container: `docker compose -f docker-compose.upstream.yml up -d`
3. Verify health
4. If health fails, reverse: stop upstream, start old fork

---

## 6. Per-Node Deployment Details

### Docker Compose template (Jinja2)

Each node gets a `docker-compose.upstream.yml` generated by Ansible:

```yaml
services:
  openclaw-upstream:
    image: openclaw:fleet-2026.3.24
    environment:
      HOME: /home/node
      TERM: xterm-256color
      TZ: America/Chicago
      OPENCLAW_GATEWAY_TOKEN: "${OPENCLAW_GATEWAY_TOKEN}"
      # Gateway-only:
      TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN:-}"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"
      # Kubuntu-only:
      OLLAMA_HOST: "${OLLAMA_HOST:-}"
    volumes:
      - ./openclaw-data:/home/node/.openclaw
    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"
    init: true
    restart: unless-stopped
    command: >
      node dist/index.js gateway
      --bind ${OPENCLAW_GATEWAY_BIND:-loopback}
      --port 18789
    healthcheck:
      test: ["CMD", "node", "-e",
        "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    networks:
      - upstream-net

networks:
  upstream-net:
    driver: bridge
```

Node-mode instances (Kubuntu, Pop!_OS) do not run `gateway` — they connect to the Gateway WS as paired nodes. The exact command and compose template differ:

- **Gateway:** `node dist/index.js gateway --bind tailnet --port 18789`
- **Nodes:** Nodes do not need to run a persistent process in this initial phase. They pair via `openclaw nodes pair` and the Gateway handles all channels. Node processes are needed later when we add distributed tool execution (Sub-Project 3+).

**Revised plan for nodes:** In the base platform phase, only the Gateway runs the openclaw-upstream container. Kubuntu and Pop!_OS get the image pulled and config deployed, but containers are not started until node-mode capabilities are needed.

---

## 7. Tailscale Networking

Upstream OpenClaw has native Tailscale awareness (`src/infra/tailnet.ts`). When `gateway.bind: "tailnet"` is set, it auto-detects the Tailscale interface and binds to it.

### Network topology

```
Mac (100.96.154.112)
  └── ws://100.69.32.10:18789 (Gateway WS)

Kubuntu (100.93.214.109)
  └── ws://100.69.32.10:18789 (Gateway WS)

Pop!_OS (100.119.126.67)
  └── ws://100.69.32.10:18789 (Gateway WS)

Gateway VPS (100.69.32.10)
  ├── :18789 — OpenClaw Gateway (bound to tailnet IP)
  ├── :443  — nginx (public HTTPS)
  └── :54321 — Supabase (loopback only)
```

### Requirements

- The Gateway container must see the Tailscale interface. Options:
  - **`network_mode: host`** — simplest, Gateway binds directly to host's Tailscale IP. Drawback: loses Docker network isolation.
  - **Publish port + bind to 0.0.0.0** — Gateway binds inside the container, Docker publishes `18789` to the host. External clients reach it via the host's Tailscale IP. This is the safer option.
- **Decision: Publish port approach.** The compose file publishes `18789:18789` and sets `--bind lan` (which binds to `0.0.0.0` inside the container). Docker's port mapping makes it reachable on the host's Tailscale IP. This avoids `network_mode: host` while still being accessible over Tailscale.

### Firewall considerations

- Gateway VPS: Port 18789 must be accessible from Tailscale IPs. If UFW is active, add `ufw allow from 100.64.0.0/10 to any port 18789`.
- Kubuntu/Pop!_OS: No inbound ports needed (they connect outbound to Gateway).
- Mac: No firewall changes needed for local development.

---

## 8. Health Verification

### Automated checks (Ansible smoke test)

Extend the existing `smoke-test.yml` playbook with upstream checks:

1. **Container running:** `docker compose -f docker-compose.upstream.yml ps` shows `healthy`
2. **Gateway HTTP health:** `curl -sf http://127.0.0.1:18789/healthz` returns 200
3. **Gateway status:** `docker compose exec openclaw-upstream node dist/index.js status` shows `Runtime: running`
4. **Telegram channel up:** `docker compose exec openclaw-upstream node dist/index.js channels status --probe` shows Telegram connected
5. **Cross-node reachability:** From Kubuntu, `curl -sf http://100.69.32.10:18789/healthz` returns 200

### Manual verification checklist

1. Send a DM to the Telegram bot — expect a response from upstream's built-in agent
2. Open Control UI at `http://100.69.32.10:18789/` from Mac (over Tailscale)
3. Run `openclaw health --json` from Mac CLI (via SSH tunnel or Tailscale)
4. Verify old fork services (Supabase, Archon) are unaffected: `curl http://100.69.32.10:8181/health`
5. Check logs: `docker compose -f docker-compose.upstream.yml logs --tail 50`

### Monitoring during transition

The old fork's AOP server (port 3010) and observability shipper continue running independently. They do not monitor upstream OpenClaw. Upstream has its own logging to `/tmp/openclaw/openclaw.log` inside the container (volume-mounted for persistence).

---

## 9. Rollback Strategy

The old fork is preserved in its entirety. Rollback is a container swap:

### Rollback procedure

```
# 1. Stop upstream
docker compose -f docker-compose.upstream.yml down

# 2. Restart old fork
docker compose -f docker-compose.yml up -d openclaw

# 3. Verify old fork health
docker compose ps openclaw
```

### What is preserved

| Artifact | Location | Backed up? |
|----------|----------|------------|
| Old fork source | `~/Dev_Projects/openclaw_mattbermanmods` (Mac) | Git repo |
| Old fork on Gateway | `/home/appbox/apps/openclaw/` | Git repo + Ansible can redeploy |
| Old fork on Kubuntu | `/home/jeff/apps/openclaw/` | Git repo + Ansible can redeploy |
| Old fork secrets | `secrets/*.env.enc.json` | SOPS encrypted in repo |
| Upstream config | `openclaw-data/openclaw.json` per node | New, Ansible-templated |
| Upstream state | `openclaw-data/` per node | New, expendable in base platform phase |

### Rollback triggers

Roll back if any of these occur within the first 48 hours:

- Telegram bot stops responding and cannot be recovered with `openclaw channels logout && openclaw channels login`
- Gateway health check fails persistently (>5 minutes)
- Supabase or Archon become unreachable (indicates network or resource conflict)
- Memory/CPU usage on Gateway VPS exceeds acceptable thresholds (upstream is Node.js, different resource profile than the Python fork)

---

## 10. Dependencies on Other Sub-Projects

This spec intentionally omits several concerns that belong to later sub-projects:

| Concern | Sub-Project | Why not here |
|---------|-------------|--------------|
| Custom plugin porting (27 tools, agentic loop) | SP-2: Plugin Migration | Requires upstream plugin SDK knowledge |
| Distributed worker fleet (worktree isolation) | SP-3: Worker Architecture | Requires node pairing + tool delegation |
| Observability migration (AOP, session tracing) | SP-4: Observability | Requires plugin hooks into upstream events |
| Fleet upgrade automation | SP-5: Upgrade Manager | Requires running upstream as baseline |
| Web outpost migration | SP-2 or SP-3 | Content pipeline is a custom plugin |
| CRM, backup, council capabilities | SP-2 | All become upstream plugins |
| fleet-redis integration | SP-3 | Distributed locking is worker-layer concern |
| HumbleForge art pipeline integration | SP-2 | Chat tools become upstream skills |

### What upstream provides that replaces fork capabilities

| Fork capability | Upstream equivalent | Notes |
|----------------|-------------------|-------|
| Telegram bot (basic messaging) | Built-in Telegram channel | Config-driven, no code needed |
| Cron framework | Upstream heartbeat + automation hooks | Different paradigm, needs SP-2 |
| LLM routing (Ollama + cloud) | Extension-based providers | Ollama + Anthropic extensions |
| Health checks | `openclaw health`, `/healthz` | Built-in |
| Self-update | `src/infra/update-runner.ts` | Built-in, SP-5 manages it |
| Node discovery | Tailnet + Bonjour discovery | Built-in |

### What the fork has that upstream does NOT

These require custom plugins (SP-2):

- 27-tool agentic Telegram bot (fleet ops, GitHub, knowledge, web search, Claude Code delegation)
- Notification batching (3-tier: critical/high/medium)
- Nightly self-improvement council
- Content pipeline (web outpost, YouTube data)
- CRM with semantic search
- Financial tracking
- Backup/recovery automation
- Archon task integration

---

## Open Questions

1. **Telegram bot token conflict:** The old fork and upstream cannot both poll the same Telegram bot token. During cutover, the old fork must have its Telegram polling stopped (or token cleared) before upstream starts. This is a sequencing concern for the Ansible playbook.

2. **Resource budget on Gateway VPS:** The Gateway VPS has 16 GB RAM and 8 CPU cores. It currently runs Supabase (PostgreSQL + Kong + PostgREST), Archon (Python + PyTorch), nginx, web outpost, AOP server, and the old fork. Adding a Node.js gateway process is modest (~200-400 MB RSS), but PyTorch's memory usage is unpredictable. Monitor after deployment.

3. **Node mode timing:** This spec defers node-mode containers on Kubuntu/Pop!_OS. If distributed tool execution is needed sooner than SP-3, the compose template and pairing flow are ready to deploy. The image will already be pulled.

4. **Config drift:** Upstream's `openclaw.json` is a single file with strict validation. The Ansible Jinja2 template must be the source of truth. Manual edits on nodes will be overwritten on next deploy. Should we add a `openclaw.local.json` merge mechanism, or enforce Ansible-only config?
