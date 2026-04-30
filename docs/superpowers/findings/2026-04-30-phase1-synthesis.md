# Phase 1 Findings — OpenClaw 4.27 Audit

**Date:** 2026-04-30
**Container build:** 4.27 (running, openclaw:local)
**Checkout HEAD:** 12ad809e79
**origin/main:** 388019f5b6

---

## Drift findings (Subagent A — file/config)

| # | Path | What changed (concise) | Classification | One-line rationale |
|---|------|------------------------|----------------|--------------------|
| 1 | `Dockerfile.local` | New file not in origin/main; pulls `ghcr.io/openclaw/openclaw:latest` base + installs custom apt packages via `docker/apt-packages.txt` | [intentional] | Local dev customization: Docker CLI + ripgrep on top of upstream image |
| 2 | `docker-compose.yml` (ports) | Ports hardbound to `127.0.0.1:18789/18790` vs. origin `0.0.0.0` | [intentional] | Loopback-only binding for local/secure environment |
| 3 | `docker-compose.yml` (image/build) | Removed `build: .`; uses `image: ${OPENCLAW_IMAGE:-openclaw:local}` | [intentional] | Pre-built local image strategy |
| 4 | `docker-compose.yml` (plugin-runtime-deps) | **Missing `openclaw-plugin-runtime-deps` volume and `OPENCLAW_PLUGIN_STAGE_DIR` env var** | **[stale]** | **⚠️ Critical: upstream added plugin staging infrastructure; absence causes runtime dep install failures (see Runtime #4–7)** |
| 5 | `docker-compose.yml` (env vars) | Missing `OTEL_*` (OpenTelemetry), `OPENCLAW_DISABLE_BONJOUR`, `OPENCLAW_PLUGIN_STAGE_DIR` | [stale] | Upstream added observability + plugin features; local config predates these |
| 6 | `docker-compose.yml` (extra_hosts) | Missing `extra_hosts: host.docker.internal:host-gateway` | [stale] | Upstream added Linux host gateway mapping for LM Studio/Ollama integration |
| 7 | `docker-compose.yml` (volume defaults) | Uses explicit `${OPENCLAW_CONFIG_DIR}` paths without fallbacks | [intentional] | Hardcoded mounts under `/home/ubuntu/.openclaw` for predictable deployment |
| 8 | `docker-compose.yml` (extra services) | Local adds etcd, minio, milvus-standalone, ollama services | [intentional] | Extended stack for semantic search + local model inference |
| 9 | `.env.example` (OPENCLAW_GATEWAY_TOKEN) | Old `change-me-to-a-long-random-token` placeholder vs. upstream auto-gen guidance | [stale] | Upstream improved security guidance |
| 10 | `.env.example` (providers) | Missing `TOKENHUB_API_KEY`, `LKEAP_API_KEY`, `INWORLD_API_KEY` | [stale] | Upstream added new provider integrations since local copy |
| 11 | `docs/docs.json` (description) | Local: 4 channels vs. origin: 10 channels listed | [stale] | Upstream expanded channel coverage; local docs outdated |
| 12 | `docs/docs.json` (navbar) | Missing Discord community invite link | [stale] | Upstream added community link; local out of sync |
| 13 | `docker/apt-packages.txt` | New file: `docker.io` + `ripgrep` | [intentional] | Local deployment tooling |
| 14 | `.env` (local) | Deployment-specific values: paths, image name, ports, API keys, DOCKER_GID | [intentional] | Expected environment-specific config |

### Notable CHANGELOG / commit grep findings

**Directly relevant to Discord SecretRef symptom:**
- `ec7536078f` fix(config): validate unresolved SecretRef refs in dry-run
- `bb44909262` docs: update changelog for Discord SecretRef accessor (#74737)
- `e4ca4c7fbf` fix(discord): avoid resolving tokens for read-only accessors
- `afb17eade9` fix(secrets): skip optional web fetch discovery before bind

**Plugin runtime-deps hardening (directly explains Runtime #4–7):**
- `eb8e892df9` fix(plugins): harden runtime mirrors
- `2a54427aba` fix(plugins): keep runtime deps manifest complete
- `6dbaa0a278` fix(plugins): keep disabled plugin runtime deps off
- `1ff1fbe682` fix(plugins): honor runtime deps fallback install option
- `b876ecdb84` fix(plugins): select runtime deps by configured models
- `8cf724a381` fix(plugins): simplify bundled runtime deps staging
- `2d885a2402` fix(plugins): disambiguate runtime-deps lock owners by process start-time
- `4c712d3372` fix: add bundled plugin deps repair command
- `b53ec93ed9` refactor(plugins): split bundled runtime deps staging script

---

## Runtime findings (Subagent B — live container)

| # | Source | Message snippet (≤80 chars) | Classification | One-line note |
|---|--------|-----------------------------|----------------|---------------|
| 1 | status CLI | `channels.discord.token: unresolved SecretRef` | [symptom-known] | Discord token not resolved; Phase 2 diagnosis below |
| 2 | doctor | `plugins.openrouter-image-generation: providerAuthEnvVars deprecated` | [symptom-known] | Deprecation warning; Phase 2 diagnosis below |
| 3 | doctor | `Gateway bound to "lan" (0.0.0.0); network-accessible` | [noise] | Known LAN binding; intentional deployment choice |
| 4 | container logs | `[plugins] discord failed to stage bundled runtime deps` | **[symptom-new]** | **⚠️ Discord plugin cannot install discord-api-types@^0.38.47 during staging** |
| 5 | container logs | `npm tar ENOENT: Cannot cd into @google/genai; @mariozechner/pi-ai/dist` | **[symptom-new]** | **⚠️ Plugin runtime dep tar extraction failure; corrupted or missing archives** |
| 6 | container logs | `[plugins] failed to install bundled runtime deps after 16605ms` | **[symptom-new]** | **⚠️ Critical: gateway falls back to per-plugin installs; partial functionality** |
| 7 | container logs | `plugin service failed (browser-control): Cannot find module @modelcontextprotocol/sdk/dist/esm` | **[symptom-new]** | **⚠️ browser-control plugin dead; MCP SDK missing from plugin-runtime-deps** |
| 8 | container logs | `liveness warning: event_loop_delay max 80933ms, cpu 0.925, utilization 0.999` | **[symptom-new]** | **⚠️ Gateway severely CPU-bound; event loop stalled up to 80s** |
| 9 | container logs | `stuck session: agent:main:main state=processing age=200s queueDepth=1` | **[symptom-new]** | **⚠️ Main agent session stuck; likely caused by npm install fallback consuming CPU** |
| 10 | logs | `startup model warmup timed out after 5000ms` | [noise] | Known warmup timeout; gateway continues |
| 11 | doctor | `Skills status: 66 eligible, 48 missing requirements` | [noise] | Normal missing-key counts; expected |
| 12 | logs | `memory-core: managed dreaming cron unavailable` | [noise] | Known QMD memory system timeout |
| 13 | doctor | `Multiple state directories detected (~/.openclaw)` | [symptom-new] | Advisory: split session history possible |

---

## Cross-reference: drift explains runtime

| Drift # | Drift finding | Runtime # | Runtime symptom |
|---------|---------------|-----------|-----------------|
| 4 | Missing `openclaw-plugin-runtime-deps` volume + `OPENCLAW_PLUGIN_STAGE_DIR` | 4, 5, 6, 7 | Bundled dep staging fails → discord/browser-control/MCP SDK missing |
| 4 | (same) | 8, 9 | npm fallback installs saturate CPU → event loop stalls → main agent stuck |
| — | CHANGELOG `e4ca4c7fbf` fix(discord): avoid resolving tokens for read-only accessors | 1 | Discord SecretRef unresolved on non-token-requiring calls |

**Root-cause chain:**
Missing plugin-runtime-deps volume → staging fails → npm fallback runs → CPU saturated → event loop delay 80s → agent stuck at queue depth 1.

---

## dist/ module paths (for Phase 2 diagnoses)

**Secret-resolver modules:**
- `dist/setup.gateway-config-D4sn1Ikw.js`
- `dist/provider-auth-ref-COrNyScq.js`
- `dist/models-config.providers.secrets-44nBQZt2.js`
- `dist/startup-auth-ytEf8nHI.js`
- `dist/auth-config-utils-7700zW4H.js`
- `dist/zod-schema.core-urFIFYTN.js`

**Plugin-loader modules:**
- `dist/plugin-registry-QPmTrBNc.js`
- `dist/gateway-startup-plugin-ids-BthrJK4f.js`
- `dist/effective-plugin-ids-2r-YcgY9.js`
- `dist/metadata-registry-loader-Cz3nFBZO.js`
- `dist/command-startup-policy-B50iOoD7.js`
- `dist/facade-activation-check.runtime.js`

---

## Installed plugins
72 plugins loaded, 45 disabled, 0 errors (per doctor). Plugin directory: `/home/node/.openclaw/plugins/installs.json` (111KB manifest).

---

*Phase 2 diagnoses appended below after running Tasks 4 & 5.*
