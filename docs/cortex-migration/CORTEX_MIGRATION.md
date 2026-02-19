# Athena → Cortex: Backend Consolidation Analysis

## Context

**Athena** (OpenClaw) is a local-first, multi-channel AI agent gateway (Node.js/TypeScript) that runs on user devices and connects to 40+ messaging channels. **Cortex** is a Python/FastAPI multi-plane backend framework deployed on Vercel. Both systems have significant functional overlap in AI proxying, tool management, memory/embeddings, usage tracking, and OAuth. The goal is to make Athena a thin client/gateway that delegates all backend work to Cortex, eliminating duplication while preserving Athena's local-device access and multi-channel connectivity.

An initial bridge already exists: `extensions/cortex-tools/` discovers Cortex MCP tools and registers them as native Athena agent tools via REST API.

---

## Decisions

- **Cortex-only for LLM calls** — no local API key fallback. Cortex is the sole path.
- **Memory stays local for now** — defer memory migration to a future phase. Focus on AI proxy first.
- **Tools stay local for now** — web-fetch, image, TTS all work fine locally. Don't move them to Cortex yet. The priority is eliminating the auth-profiles complexity.

---

## Module-by-Module Breakdown

### STRIP from Athena → Use Cortex Instead

#### 1. AI Provider Auth & Routing (HIGH OVERLAP — PRIMARY TARGET)

- **Athena**: `src/agents/auth-profiles/` (17 files) — Multi-provider credential storage, failover chains, cooldown/backoff logic, usage stats, OAuth token management
- **Cortex**: Apollo plane — AI proxy with multi-auth (user key → OAuth → org fallback), rate limiting (RPM, daily tokens, monthly spend), streaming, cost calculation in microdollars
- **Action**: **Strip Athena's auth-profiles entirely.** Route all LLM calls through Cortex Apollo (`/api/v1/ai/messages`). Cortex already handles key resolution, failover, rate limiting, and cost tracking. Athena only needs to store its Cortex API key (`ctx_...`), not individual provider keys. No local fallback — Cortex is the sole path.
- **Files to remove/gut**: `src/agents/auth-profiles/*.ts` (profiles.ts, usage.ts, oauth.ts, store.ts, order.ts, cooldown logic, repair.ts, doctor.ts, constants.ts, display.ts, external-cli-sync.ts, session-override.ts, paths.ts, types.ts + all tests)
- **What stays**: A minimal config to point at Cortex (URL + API key), already in cortex-tools plugin config

#### 2. Usage Tracking & Cost Calculation (FULL OVERLAP)

- **Athena**: Per-session usage tracking in agent runtime
- **Cortex**: `ai_usage_logs`, `ai_usage_daily` tables, `UsageTracker`, `CostCalculator`, `/api/v1/ai/usage` endpoints
- **Action**: **Strip all local usage tracking.** Cortex Apollo logs every request with `cortexUsage` metadata (tokens, cost, latency, model). Athena can query Cortex for usage reports.
- **Files affected**: Usage tracking scattered through `src/agents/` runtime

#### 3. OAuth Token Management for External Services (PARTIAL OVERLAP — FUTURE)

- **Athena**: OAuth flow support for channel auth tokens
- **Cortex**: `hermes/oauth/` — Full OAuth lifecycle for GitHub, Supabase, Vercel, Anthropic with encrypted Fernet storage
- **Action**: **Future phase.** Move external-service OAuth to Cortex. Channel-specific tokens (Slack bot token, Discord bot token) stay local. But OAuth for GitHub, Supabase, Vercel, Anthropic should eventually be Cortex-managed.
- **Files affected**: `src/agents/auth-profiles/oauth.ts`, external-service credential handling

### DEFERRED (Keep Local For Now)

#### 4. Memory & Embeddings

- **Athena**: `src/memory/` (70+ files) — LanceDB/SQLite-vec, embedding providers, semantic search, MMR, query expansion, temporal decay
- **Cortex**: Chronos plane — Pinecone + Neo4j
- **Action**: **Keep local.** Memory is complex, works well locally, and migration is high-risk. Revisit after AI proxy consolidation is stable.

#### 5. Web/Image/TTS Tools

- **Athena**: `src/agents/tools/web-fetch.ts`, `web-search.ts`, `image-tool.ts`, `tts-tool.ts`
- **Action**: **Keep local.** These work fine on-device. Web fetch has no privacy concern worth the complexity. Image processing needs local files. TTS audio needs to reach the local device for channel delivery. Moving these adds latency for no meaningful benefit.

---

### REFACTOR in Athena → Thin Wrapper Calling Cortex

#### 6. Agent Runtime / LLM Calls

- **Athena**: `src/agents/` — pi-agent-core reasoning engine, tool execution loop, model selection
- **Current flow**: Athena picks a model → resolves auth profile → calls provider API directly → tracks usage locally
- **New flow**: Athena's agent runtime calls Cortex Apollo for all LLM interactions. The reasoning loop stays local (it's the core of what Athena does), but the actual model API call goes through Cortex.
- **Action**: Refactor model invocation in the agent runtime to point `baseUrl` at Cortex Apollo. Set the Anthropic provider's `baseUrl` to `https://cortex.yourcompany.com/api/v1/ai` with the Cortex API key (`ctx_...`).
- **Files affected**: `src/agents/` model invocation path, provider configuration

#### 7. Tool Registry (Cortex MCP tools via bridge)

- **Athena**: `src/agents/tools/` (65+ files) + `extensions/cortex-tools/`
- **Cortex**: Hermes plane — 12 MCPs
- **Action**: Keep all local tools as-is. The existing `cortex-tools` bridge already handles Cortex MCPs. No changes needed here for Phase 1.
- **Files affected**: None for now

---

### KEEP in Athena (No Cortex Equivalent Needed)

These are inherently local and must remain in Athena:

| Module                   | Path                                 | Reason                                             |
| ------------------------ | ------------------------------------ | -------------------------------------------------- |
| **Gateway Server**       | `src/gateway/`                       | WebSocket + HTTP control plane, local connectivity |
| **Channel Integrations** | `src/channels/` + `extensions/`      | 40+ messaging platforms, need local device access  |
| **CLI & Commands**       | `src/cli/`, `src/commands/`          | User-facing terminal interface                     |
| **Daemon Management**    | `src/daemon/`                        | Local process supervision (systemd/launchd)        |
| **Browser Automation**   | `src/browser/`                       | Needs local Chrome/Chromium instance               |
| **Media Processing**     | `src/media/`                         | Local image/audio ops (Sharp), format detection    |
| **Auto-Reply System**    | `src/auto-reply/`                    | Message dispatch, streaming, chunking              |
| **Config Management**    | `src/config/`                        | Local YAML/JSON config, hot reload                 |
| **Plugin System**        | `src/plugins/`                       | Core extensibility mechanism                       |
| **Native Apps**          | `apps/`                              | macOS, iOS, Android                                |
| **Device Pairing**       | Bonjour discovery                    | Local network only                                 |
| **Hooks System**         | `src/hooks/`                         | Plugin extension points                            |
| **Local Channel Tools**  | discord-actions, slack-actions, etc. | Need runtime access to channel SDKs                |

---

## Overlap Summary Matrix

| Capability           | Athena Today                | Cortex Today                   | After Migration                                |
| -------------------- | --------------------------- | ------------------------------ | ---------------------------------------------- |
| AI API calls         | auth-profiles → direct API  | Apollo proxy                   | Athena → Cortex Apollo                         |
| Rate limiting        | Profile cooldowns           | RPM/daily/monthly limits       | Cortex only                                    |
| Cost tracking        | Per-session local           | Microdollar precision, DB logs | Cortex only                                    |
| Usage dashboards     | None                        | `/api/v1/ai/usage`             | Cortex only                                    |
| Vector memory        | LanceDB/SQLite-vec local    | Pinecone + Neo4j               | Local (deferred)                               |
| Embeddings           | Voyage/OpenAI/Gemini local  | Cortex Chronos                 | Local (deferred)                               |
| Semantic search      | Local MMR + query expansion | Cortex Chronos                 | Local (deferred)                               |
| MCP tools            | cortex-tools bridge         | 12 MCPs native                 | Cortex (bridge stays)                          |
| Web fetch/search     | Local tools                 | Web quality MCP                | Local (deferred)                               |
| OAuth (ext services) | Local files                 | Fernet-encrypted DB            | Local (deferred)                               |
| OAuth (channels)     | Local per-channel           | N/A                            | Athena (stays local)                           |
| Channel messaging    | 40+ channels local          | N/A                            | Athena (stays local)                           |
| Browser automation   | Local Playwright/CDP        | N/A                            | Athena (stays local)                           |
| Shell execution      | system.run local            | BashMCP                        | Both (local for Athena, MCP for Cortex remote) |

---

## Staged Implementation Plan

### Stage 1A: Wire Cortex Apollo as LLM Backend

**Route all LLM calls through Cortex Apollo. No code deletion yet.**

1. In Athena's config, set the Anthropic provider `baseUrl` → Cortex Apollo URL (`https://cortex-bice.vercel.app/api/v1/ai`)
2. Set API key to Cortex key (`ctx_...`) — single key replaces all provider keys
3. Verify streaming works end-to-end (Apollo supports SSE via `?stream=true`)
4. Verify non-streaming works
5. Verify usage shows up in Cortex dashboard (`GET /api/v1/ai/usage`)
6. Test across multiple channels (WhatsApp, Telegram, Slack, Discord)

This is config-only — no code changes. Proves the integration works before touching anything.

**Status**: [ ] Not started

---

### Stage 1B: Strip Auth Profiles

**Remove the 17-file auth-profiles system.**

1. Bypass the auth-profile resolution logic in the agent runtime — hardcode Cortex as the sole provider
2. Remove `src/agents/auth-profiles/` entirely (profiles.ts, usage.ts, oauth.ts, store.ts, order.ts, repair.ts, doctor.ts, constants.ts, display.ts, external-cli-sync.ts, session-override.ts, paths.ts, types.ts + all tests)
3. Remove local usage tracking code scattered through agent runtime
4. Simplify onboarding wizard — no more "add your API key" flow, just "connect to Cortex" (URL + key)
5. Update `athena doctor` command to check Cortex connectivity instead of API key validity
6. Update docs

**Status**: [ ] Not started | **Depends on**: Stage 1A verified

---

### Stage 1C: Simplify Config & Onboarding

**Clean up config to reflect the new Cortex-first architecture.**

1. Make `cortex.url` and `cortex.apiKey` top-level config fields (not nested under plugins)
2. Remove provider-specific config sections that are now irrelevant
3. Update CLI `athena onboard` to guide users through Cortex connection
4. Ensure `extensions/cortex-tools/` picks up the same Cortex config (single source of truth)

**Status**: [ ] Not started | **Depends on**: Stage 1B complete

---

### Future Stages (Not In Scope Now)

| Stage       | Description         | Scope                                                       |
| ----------- | ------------------- | ----------------------------------------------------------- |
| **Stage 2** | Memory migration    | Move `src/memory/` (70+ files) to Cortex Chronos            |
| **Stage 3** | OAuth consolidation | Move external-service OAuth to Cortex Hermes                |
| **Stage 4** | Web tool delegation | Move web-fetch/search to Cortex MCPs                        |
| **Stage 5** | Media offloading    | Move image/TTS processing to Cortex (if latency acceptable) |

---

## Cortex Work Needed (Stage 1 Only)

| Item                     | Status         | Notes                                                                       |
| ------------------------ | -------------- | --------------------------------------------------------------------------- |
| Apollo AI proxy          | Already exists | `/api/v1/ai/messages` with streaming                                        |
| Rate limiting            | Already exists | RPM, daily tokens, monthly spend                                            |
| Usage tracking           | Already exists | `ai_usage_logs`, `ai_usage_daily`                                           |
| Cost calculation         | Already exists | Microdollar precision                                                       |
| API key auth             | Already exists | `X-API-Key: ctx_...` header                                                 |
| Anthropic-compatible API | **Verify**     | Confirm Apollo's request/response format matches what pi-agent-core expects |

Stage 1 requires **zero new Cortex code** — it's all about wiring Athena to existing Cortex endpoints.

---

## Risks & Mitigations

| Risk                                  | Impact     | Mitigation                                                                                            |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| Cortex downtime = Athena can't reason | High       | Accept this tradeoff (user decision). Monitor Cortex uptime.                                          |
| Latency increase for AI calls         | Low-Medium | Extra hop adds ~50-100ms. Streaming mitigates perceived latency.                                      |
| Apollo request format mismatch        | Medium     | Verify Apollo matches Anthropic's API format that pi-agent-core expects before removing auth-profiles |
| Onboarding regression                 | Low        | Test full onboard flow after changes                                                                  |
| Plugin compatibility                  | Low        | Plugins use tool API, not auth-profiles directly                                                      |

---

## Estimated Code Reduction

### Stage 1 (Now)

| Module            | Files Removed    | Approx LOC |
| ----------------- | ---------------- | ---------- |
| auth-profiles     | 17 files + tests | ~2,000     |
| usage tracking    | Scattered        | ~500       |
| **Stage 1 Total** | **~20 files**    | **~2,500** |

### Future Stages

| Module              | Files         | Approx LOC  |
| ------------------- | ------------- | ----------- |
| Memory + extensions | ~80 files     | ~6,000+     |
| Web tools           | ~15 files     | ~1,500      |
| **Future Total**    | **~95 files** | **~7,500+** |

**Grand Total**: ~115 files / ~10,000+ LOC eliminated

---

## Verification Checklist

### Stage 1A (config only)

- [ ] Send a message via WhatsApp → verify LLM response
- [ ] Send a message via Telegram → verify streaming works
- [ ] Check `GET /api/v1/ai/usage` on Cortex → verify request logged
- [ ] Verify rate limiting works (hit the limit, confirm graceful error)

### Stage 1B (auth-profiles removed)

- [ ] `athena gateway` starts without errors
- [ ] Agent responds to messages across all channels
- [ ] No local API key files remain in `~/.athena/` or agent workspace
- [ ] `athena doctor` reports healthy Cortex connection

### Stage 1C (config simplified)

- [ ] `athena onboard` guides through Cortex setup
- [ ] `cortex-tools` extension picks up tools successfully
- [ ] All Cortex MCPs available as agent tools
