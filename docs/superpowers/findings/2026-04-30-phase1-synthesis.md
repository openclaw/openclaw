# Phase 1 Findings — OpenClaw 4.27 Audit

**Date:** 2026-04-30
**Container build:** 4.27 (running, openclaw:local)
**Checkout HEAD:** 12ad809e79
**origin/main:** 388019f5b6

---

## Drift findings (Subagent A — file/config)

| #   | Path                                       | What changed (concise)                                                                                                                  | Classification | One-line rationale                                                                                                            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Dockerfile.local`                         | New file not in origin/main; pulls `ghcr.io/openclaw/openclaw:latest` base + installs custom apt packages via `docker/apt-packages.txt` | [intentional]  | Local dev customization: Docker CLI + ripgrep on top of upstream image                                                        |
| 2   | `docker-compose.yml` (ports)               | Ports hardbound to `127.0.0.1:18789/18790` vs. origin `0.0.0.0`                                                                         | [intentional]  | Loopback-only binding for local/secure environment                                                                            |
| 3   | `docker-compose.yml` (image/build)         | Removed `build: .`; uses `image: ${OPENCLAW_IMAGE:-openclaw:local}`                                                                     | [intentional]  | Pre-built local image strategy                                                                                                |
| 4   | `docker-compose.yml` (plugin-runtime-deps) | **Missing `openclaw-plugin-runtime-deps` volume and `OPENCLAW_PLUGIN_STAGE_DIR` env var**                                               | **[stale]**    | **⚠️ Critical: upstream added plugin staging infrastructure; absence causes runtime dep install failures (see Runtime #4–7)** |
| 5   | `docker-compose.yml` (env vars)            | Missing `OTEL_*` (OpenTelemetry), `OPENCLAW_DISABLE_BONJOUR`, `OPENCLAW_PLUGIN_STAGE_DIR`                                               | [stale]        | Upstream added observability + plugin features; local config predates these                                                   |
| 6   | `docker-compose.yml` (extra_hosts)         | Missing `extra_hosts: host.docker.internal:host-gateway`                                                                                | [stale]        | Upstream added Linux host gateway mapping for LM Studio/Ollama integration                                                    |
| 7   | `docker-compose.yml` (volume defaults)     | Uses explicit `${OPENCLAW_CONFIG_DIR}` paths without fallbacks                                                                          | [intentional]  | Hardcoded mounts under `/home/ubuntu/.openclaw` for predictable deployment                                                    |
| 8   | `docker-compose.yml` (extra services)      | Local adds etcd, minio, milvus-standalone, ollama services                                                                              | [intentional]  | Extended stack for semantic search + local model inference                                                                    |
| 9   | `.env.example` (OPENCLAW_GATEWAY_TOKEN)    | Old `change-me-to-a-long-random-token` placeholder vs. upstream auto-gen guidance                                                       | [stale]        | Upstream improved security guidance                                                                                           |
| 10  | `.env.example` (providers)                 | Missing `TOKENHUB_API_KEY`, `LKEAP_API_KEY`, `INWORLD_API_KEY`                                                                          | [stale]        | Upstream added new provider integrations since local copy                                                                     |
| 11  | `docs/docs.json` (description)             | Local: 4 channels vs. origin: 10 channels listed                                                                                        | [stale]        | Upstream expanded channel coverage; local docs outdated                                                                       |
| 12  | `docs/docs.json` (navbar)                  | Missing Discord community invite link                                                                                                   | [stale]        | Upstream added community link; local out of sync                                                                              |
| 13  | `docker/apt-packages.txt`                  | New file: `docker.io` + `ripgrep`                                                                                                       | [intentional]  | Local deployment tooling                                                                                                      |
| 14  | `.env` (local)                             | Deployment-specific values: paths, image name, ports, API keys, DOCKER_GID                                                              | [intentional]  | Expected environment-specific config                                                                                          |

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

| #   | Source         | Message snippet (≤80 chars)                                                                      | Classification    | One-line note                                                                        |
| --- | -------------- | ------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------ |
| 1   | status CLI     | `channels.discord.token: unresolved SecretRef`                                                   | [symptom-known]   | Discord token not resolved; Phase 2 diagnosis below                                  |
| 2   | doctor         | `plugins.openrouter-image-generation: providerAuthEnvVars deprecated`                            | [symptom-known]   | Deprecation warning; Phase 2 diagnosis below                                         |
| 3   | doctor         | `Gateway bound to "lan" (0.0.0.0); network-accessible`                                           | [noise]           | Known LAN binding; intentional deployment choice                                     |
| 4   | container logs | `[plugins] discord failed to stage bundled runtime deps`                                         | **[symptom-new]** | **⚠️ Discord plugin cannot install discord-api-types@^0.38.47 during staging**       |
| 5   | container logs | `npm tar ENOENT: Cannot cd into @google/genai; @mariozechner/pi-ai/dist`                         | **[symptom-new]** | **⚠️ Plugin runtime dep tar extraction failure; corrupted or missing archives**      |
| 6   | container logs | `[plugins] failed to install bundled runtime deps after 16605ms`                                 | **[symptom-new]** | **⚠️ Critical: gateway falls back to per-plugin installs; partial functionality**    |
| 7   | container logs | `plugin service failed (browser-control): Cannot find module @modelcontextprotocol/sdk/dist/esm` | **[symptom-new]** | **⚠️ browser-control plugin dead; MCP SDK missing from plugin-runtime-deps**         |
| 8   | container logs | `liveness warning: event_loop_delay max 80933ms, cpu 0.925, utilization 0.999`                   | **[symptom-new]** | **⚠️ Gateway severely CPU-bound; event loop stalled up to 80s**                      |
| 9   | container logs | `stuck session: agent:main:main state=processing age=200s queueDepth=1`                          | **[symptom-new]** | **⚠️ Main agent session stuck; likely caused by npm install fallback consuming CPU** |
| 10  | logs           | `startup model warmup timed out after 5000ms`                                                    | [noise]           | Known warmup timeout; gateway continues                                              |
| 11  | doctor         | `Skills status: 66 eligible, 48 missing requirements`                                            | [noise]           | Normal missing-key counts; expected                                                  |
| 12  | logs           | `memory-core: managed dreaming cron unavailable`                                                 | [noise]           | Known QMD memory system timeout                                                      |
| 13  | doctor         | `Multiple state directories detected (~/.openclaw)`                                              | [symptom-new]     | Advisory: split session history possible                                             |

---

## Cross-reference: drift explains runtime

| Drift # | Drift finding                                                                       | Runtime #  | Runtime symptom                                                           |
| ------- | ----------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| 4       | Missing `openclaw-plugin-runtime-deps` volume + `OPENCLAW_PLUGIN_STAGE_DIR`         | 4, 5, 6, 7 | Bundled dep staging fails → discord/browser-control/MCP SDK missing       |
| 4       | (same)                                                                              | 8, 9       | npm fallback installs saturate CPU → event loop stalls → main agent stuck |
| —       | CHANGELOG `e4ca4c7fbf` fix(discord): avoid resolving tokens for read-only accessors | 1          | Discord SecretRef unresolved on non-token-requiring calls                 |

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

_Phase 2 diagnoses appended below after running Tasks 4 & 5._

---

## Phase 2 — Diagnosis: openrouter-image-generation

**Plugin version/location:** workspace plugin at `/home/node/.openclaw/workspace/plugins/openrouter-image-generation/` (not a registry-installed package; version `0.0.1`, local-only). Manifest file: `openclaw.plugin.json` at that path.

**Warning message:** `plugins.openrouter-image-generation: providerAuthEnvVars is deprecated compatibility metadata for provider env-var lookup; mirror openrouter env vars to setup.providers[].envVars before the deprecation window closes`

**What 4.27 expects instead of providerAuthEnvVars:** The runtime now reads provider env-var lists from `setup.providers[].envVars` (an array of objects with `id` + `envVars` fields) alongside the new `providerAuthChoices` array. The deprecation was introduced in commit `7536993397` (`feat(plugins): read setup provider env vars`, 2026-04-24) and compounded by `44183de706` (`fix: use setup providers for auth choices`, 2026-04-26). The `providerAuthEnvVars` field continues to be read by the runtime until the `removeAfter` deadline of **2026-07-24** — so it is a warning, not a breakage.

**Relevant upstream changes:**

- `7536993397` feat(plugins): read setup provider env vars (#71226) — introduced `setup.providers[].envVars` as the authoritative path; marked `providerAuthEnvVars` as deprecated with `warningStarts: 2026-04-24`, `removeAfter: 2026-07-24`
- `44183de706` fix: use setup providers for auth choices — wired `setup.providers[].envVars` into the auth-choice resolver, making the migration load-bearing for future auth UX
- `2a54427aba` fix(plugins): keep runtime deps manifest complete — unrelated but confirms manifest completeness requirements tightened in 4.27

**Root cause:**

- **(c) Warning is informational only — runtime behavior unaffected; plugin continues to work.** The `openrouter-image-generation` workspace plugin declares `providerAuthEnvVars: { "openrouter": ["OPENROUTER_API_KEY"] }` in its `openclaw.plugin.json`. As of 4.27, this field is deprecated in favor of `setup.providers[].envVars`, but the deprecation window does not close until 2026-07-24. The runtime still reads `providerAuthEnvVars` for backwards compatibility, so the OPENROUTER_API_KEY lookup works correctly today. Image generation is fully functional — the doctor warning is advisory.

**Proposed fix (description — no execution):**

File to edit: `/home/node/.openclaw/workspace/plugins/openrouter-image-generation/openclaw.plugin.json`

Exact edit — replace the `providerAuthEnvVars` field with the new `setup.providers[]` structure and add a `providerAuthChoices` entry:

```json
{
  "id": "openrouter-image-generation",
  "name": "OpenRouter Image Generation",
  "description": "Adds OpenRouter-backed image generation to OpenClaw",
  "setup": {
    "providers": [
      {
        "id": "openrouter",
        "envVars": ["OPENROUTER_API_KEY"]
      }
    ]
  },
  "providerAuthChoices": [
    {
      "provider": "openrouter",
      "method": "api-key",
      "choiceId": "openrouter-api-key",
      "choiceLabel": "OpenRouter API key",
      "groupId": "openrouter",
      "groupLabel": "OpenRouter",
      "groupHint": "API key",
      "optionKey": "openrouterApiKey"
    }
  ],
  "contracts": {
    "imageGenerationProviders": ["openrouter"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Note: the write must be done as `ubuntu` via `sudo` and immediately `chown opc:opc` the file (workspace is owned by `opc`).

Reload command: no container restart needed; `docker exec openclaw-openclaw-gateway-1 node dist/index.js plugins reload` should pick up the manifest change (or a full `docker compose restart` if hot-reload is not available for workspace plugins).

Expected verification: `docker exec openclaw-openclaw-gateway-1 node dist/index.js doctor 2>&1 | grep openrouter-image-generation` shows no deprecation warning (or the line is absent from the Config warnings and Plugin diagnostics sections).

---

## Phase 2 — Diagnosis: Discord SecretRef

**Reference shape in user config:** `{ source: "file", provider: "filemain", id: "/providers/discord/chiefOfStaff/token" }` — a modern three-key SecretRef object stored inline at `channels.discord.token`. The `filemain` provider is configured as `source: file, mode: json, path: /home/node/.openclaw/secrets.json`. The pointer `/providers/discord/chiefOfStaff/token` resolves successfully to a string of length 72 in `secrets.json`; the underlying secret is present and intact.

**Resolver supports source types:** `env`, `file`, `exec` (lazy-loaded via `dist/resolve-CGQ2EabZ.js` → `dist/resolve-CKxwAAOr.js`). The resolver also handles legacy refs without a `provider` field via `coerceSecretRef`, and `${ENV_VAR}` template strings via `parseEnvTemplateSecretRef`. The secret itself can be resolved — the issue is not in the resolver but in which call path triggers resolution.

**Upstream fix context:**

- `e4ca4c7fbf` (`fix(discord): avoid resolving tokens for read-only accessors`) — the root fix. In `extensions/discord/src/shared.ts`, `discordConfigAdapter` passes its fallback `resolveAccountForAccessors` as `params.resolveAccount(cfg, accountId)`, which calls the full `resolveDiscordAccount` → `resolveDiscordToken` → `normalizeDiscordToken` → `normalizeResolvedSecretInputString(strict)` chain even for read-only accessor calls (allowlist lookup, defaultTo resolution). The fix introduces a lean `resolveDiscordConfigAccessorAccount` helper that reads only `allowFrom` and `defaultTo` from the merged config without touching the token, and wires it as `resolveAccessorAccount` on the adapter.

- `ec7536078f` (`fix(config): validate unresolved SecretRef refs in dry-run`) — a separate fix that corrects `config patch --dry-run` to perform schema validation even when the patched path is not in the SecretRef target registry. Unrelated to the `status` error but authored the same day.

**Root cause (c — source exists but resolver behavior changed):**

The `status` command calls `buildAccountNotes` (`dist/status.scan.runtime-MRy8OcNY.js:232`) which calls `plugin.config.resolveAllowFrom({ cfg, accountId })`. The `discordConfigAdapter` (built in `dist/extensions/discord/shared-Cuv73Rz3.js`) wires `resolveAllowFrom` through `createScopedChannelConfigAdapter` → `createChannelConfigAdapterFromBase` → `resolveAccountForAccessors` which falls back to `params.resolveAccount(cfg, accountId)` — the full `resolveDiscordAccount` function. `resolveDiscordAccount` calls `resolveDiscordToken` → `normalizeDiscordToken` → `normalizeResolvedSecretInputString` in **strict mode**. In strict mode, any unresolved SecretRef (a ref object rather than an already-resolved string) throws `createUnresolvedSecretInputError`. Because `status` runs outside an active gateway runtime snapshot, the file secret is never pre-resolved before the accessor is called, causing the throw.

The fix (`e4ca4c7fbf`) exists in the upstream source tree but is **not yet merged into the local `main` branch** (confirmed: `git merge-base --is-ancestor e4ca4c7fbf HEAD` returns false) and therefore has not been compiled into the container's `dist/`. The container runs build 4.27; the fix was authored 2026-04-30, after the 4.27 release tag.

**Proposed fix (description — no execution):**

File to edit: `extensions/discord/src/shared.ts`

Exact edit: add a `resolveDiscordConfigAccessorAccount` helper that reads routing fields without touching the token, and pass it as `resolveAccessorAccount` to `createScopedChannelConfigAdapter`:

```ts
// Add imports at top of file:
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccountAllowFrom,
} from "./accounts.js";

// New helper — reads only routing fields, never touches the token:
function resolveDiscordConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const config = mergeDiscordAccountConfig(params.cfg, accountId);
  return {
    allowFrom: resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId }),
    defaultTo: config.defaultTo,
  };
}

// In discordConfigAdapter, add resolveAccessorAccount:
export const discordConfigAdapter = createScopedChannelConfigAdapter<ResolvedDiscordAccount>({
  sectionKey: DISCORD_CHANNEL,
  listAccountIds: listDiscordAccountIds,
  resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectDiscordAccount({ cfg, accountId }),
  resolveAccessorAccount: (cfg, accountId) =>
    resolveDiscordConfigAccessorAccount({ cfg, accountId }), // <-- add this line
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});
```

After the source edit: run `pnpm build`, rebuild the container image, and redeploy.

Reload command: rebuild image, then `docker compose up -d --no-deps openclaw-openclaw-gateway-1` (or equivalent local deploy script from `scripts/`).

Expected verification: `docker exec openclaw-openclaw-gateway-1 node dist/index.js status --all 2>&1 | grep -i discord` shows no `unresolved SecretRef`; the Discord row should show `token:config` in the notes column.

---

## Fix log

### Fix 1: docker-compose.yml — plugin-runtime-deps volume + extra_hosts (2026-04-30)

- Added `OPENCLAW_PLUGIN_STAGE_DIR: /var/lib/openclaw/plugin-runtime-deps` env var to `openclaw-gateway` and `openclaw-cli`
- Added `openclaw-plugin-runtime-deps:/var/lib/openclaw/plugin-runtime-deps` volume mount to both services
- Added `extra_hosts: ["host.docker.internal:host-gateway"]` to `openclaw-gateway`
- Added `openclaw-plugin-runtime-deps:` named volume to volumes block
- **Result:** Plugin staging now succeeds (18 deps installed in 20s). CPU utilization dropped from 99.9% to ~30%. Event loop delay max dropped from 80s to 11s. Gateway `ready` in 32s.
- Commit: `72207b4c9f`

### Fix 2: openrouter-image-generation plugin manifest (2026-04-30)

- Replaced `providerAuthEnvVars: { "openrouter": [...] }` with `setup.providers[].envVars` + `providerAuthChoices` in `/home/ubuntu/.openclaw/workspace/plugins/openrouter-image-generation/openclaw.plugin.json`
- Refreshed plugin registry (`plugins registry --refresh`) and restarted gateway
- **Result:** `providerAuthEnvVars deprecated` warning gone from `doctor` output
- File tracked by workspace git (not repo git)

### Fix 3: Discord SecretRef — pending

- Root cause confirmed: upstream fix `e4ca4c7fbf` not in container build 4.27 (authored 2026-04-30, will ship in 4.28+)
- Fix in progress: patching `extensions/discord/src/shared.ts` and rebuilding image

### Fix 3: Discord SecretRef (2026-04-30)

- Added `resolveDiscordConfigAccessorAccount` helper to `extensions/discord/src/shared.ts` (reads routing fields without touching the token)
- Wired it as `resolveAccessorAccount` on `discordConfigAdapter`
- Added runtime patch step in `Dockerfile.local` to patch compiled `dist/extensions/discord/shared-Cuv73Rz3.js` (hardcoded bundle filename — see concern below)
- Rebuilt local image (`docker build -t openclaw:local -f Dockerfile.local .`) and redeployed
- **Result:** No more `unresolved SecretRef` throw. Status now shows graceful WARN: `configured token unavailable in this command path` (expected — secret can't resolve outside gateway runtime snapshot)
- Commits: `7c21977411`, `24dd1ac13b`
- ⚠️ **Concern:** `Dockerfile.local` patches bundle by hardcoded filename `shared-Cuv73Rz3.js`. If upstream image is updated (e.g., to 4.29, which is already available per `openclaw status`), the patch step will silently no-op. After updating to 4.28+, verify the patch still applies OR remove it (the upstream proper fix `e4ca4c7fbf` will be included).

## Final verification (2026-04-30)

- `openclaw status --all`: Discord shows WARN (graceful), no SecretRef error
- `openclaw doctor`: `✓ Plugin compatibility (none)`, `✓ Skills: 66 eligible · 0 missing`, `✓ Secret diagnostics (0)`
- Known-noise items still present (expected, out of scope): LAN binding, Bonjour, QMD memory, agents.defaults.llm legacy advisory
- Note: OpenClaw 4.29 is already available (`pnpm · npm update 2026.4.29`). Update after verifying Dockerfile.local patch compatibility or confirming upstream fix is included.
