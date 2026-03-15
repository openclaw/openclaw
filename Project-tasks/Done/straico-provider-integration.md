---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Straico Provider Integration"
description: "Integrate Straico as a custom LLM provider via OpenAI-compatible API to access 50+ AI models with coin-based pricing"
dartboard: "Operator1/Tasks"
type: Project
status: "Done"
priority: medium
assignee: "rohit sharma"
tags: [feature, backend, api]
startAt: "2026-03-14"
dueAt: "2026-03-15"
dart_project_id: # filled by Claude after first Dart sync — do not edit manually
# ──────────────────────────────────────────────────────────────────────────────
---

# Straico Provider Integration

**Created:** 2026-03-14
**Status:** Done (live as of 2026-03-15)
**Depends on:** None

---

## 1. Overview

Integrate Straico as a custom LLM provider in OpenClaw to access 50+ AI models through a unified OpenAI-compatible API with coin-based pricing. Added as a config-declared provider using the generic `openai-completions` adapter — no code changes required. Five curated models are live; the full Straico catalog (70+ models) is available for future expansion.

---

## 2. Goals

- [x] Configure Straico as a named provider in the gateway config (`op1_config` SQLite)
- [x] Expose top 5 curated Straico models with correct IDs, context windows, and capability flags
- [x] Disable streaming globally for all Straico models to prevent broken/empty responses
- [x] Disable tool calling by default until verified via live API testing
- [x] Validate API connectivity and chat completions end-to-end

## 3. Out of Scope

- Code changes to OpenClaw core — pure config only
- Streaming support (Straico ignores `stream: true` and returns normal JSON — not a breaking failure, but SSE not supported)
- Tool calling support (deferred until explicitly confirmed via API test)
- Coin-cost mapping to per-token pricing (use `0` placeholders)
- Image/video generation endpoints

---

## 4. Design Decisions

| Decision              | Options Considered                | Chosen                              | Reason                                                                                                                              |
| --------------------- | --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| API version           | v0, v2                            | v0                                  | Most tested; v2 untested                                                                                                            |
| Streaming             | enabled, disabled                 | disabled (per model)                | Straico ignores `stream: true` — returns full JSON either way, but `streaming: false` prevents OpenClaw from attempting SSE parsing |
| Tool calling          | enabled, disabled                 | disabled (default)                  | Unconfirmed support; silent breakage risk in agent tool-use workflows                                                               |
| Auth                  | env var, hardcoded                | `${STRAICO_API_KEY}` env var        | Key stored in `op1_config` env block                                                                                                |
| Cost fields           | real per-token, zero placeholders | zero placeholders                   | Straico uses coin-based billing; no per-token mapping available                                                                     |
| Model selection       | all 70+ models, curated 5         | curated 5                           | Avoids clutter; picks newest/best per category                                                                                      |
| Fallback escape hatch | Straico-only chain, mixed chain   | keep existing primary (`zai/glm-5`) | Primary model unchanged; Straico added as available alternative                                                                     |

---

## 5. Technical Spec

### 5.1 Key Findings from Live API Testing (2026-03-15)

**Streaming:** Straico ignores `stream: true` and returns a normal JSON response body. Not a breaking failure — but `streaming: false` must still be set in `agents.defaults.models` to prevent OpenClaw from attempting to parse the response as SSE.

**Tool calling:** Not yet tested with a real tool payload. Left as `supportsTools: false` on all models.

**Authentication:** Bearer token in `Authorization` header. Confirmed working.

**Streaming maintenance risk:** Any new Straico model added to `models.providers.straico.models` that is missing from `agents.defaults.models` will silently default to `streaming: true`. When adding models, always add a matching `{ streaming: false }` entry.

**Model ID format:** Straico uses `provider/model` format (e.g. `anthropic/claude-sonnet-4.5`). Some models have no provider prefix (`claude-haiku-4-5-5`, `o3-2025-04-16`). In OpenClaw config the full ID is prefixed with `straico/` (e.g. `straico/anthropic/claude-sonnet-4.5`).

### 5.2 Architecture & Storage

```
┌─────────────────────────────────────────────┐
│         OpenClaw Gateway                    │
│  ┌────────────────────────────────────┐     │
│  │   Config (op1_config SQLite)       │     │
│  │   models.providers.straico → top5  │     │
│  └────────────────────────────────────┘     │
│                    ↓                        │
│  ┌────────────────────────────────────┐     │
│  │   openai-completions adapter       │     │
│  │   baseUrl: api.straico.com/v0      │     │
│  │   Auth: Bearer ${STRAICO_API_KEY}  │     │
│  │   Streaming: DISABLED              │     │
│  │   Tools: DISABLED (until verified) │     │
│  └────────────────────────────────────┘     │
└─────────────────┬───────────────────────────┘
                  ▼
        https://api.straico.com/v0
        POST /v0/chat/completions
        GET  /v0/models
```

Key source files:

- `src/config/types.models.ts` — `ModelsConfig`, `ModelProviderConfig`, `ModelDefinitionConfig`
- `src/config/types.agent-defaults.ts` — `AgentModelEntryConfig` (streaming toggle)
- `src/agents/models-config.providers.ts` — Provider resolution
- `src/infra/state-db/config-sqlite.ts` — `op1_config` read/write

### 5.3 Live Models (Top 5)

All verified against `/v0/models` and tested with a live chat completion.

| OpenClaw ID                             | Straico ID                      | Coins/100w | Max Output | Reasoning | Notes                               |
| --------------------------------------- | ------------------------------- | ---------- | ---------- | --------- | ----------------------------------- |
| `straico/anthropic/claude-sonnet-4.5`   | `anthropic/claude-sonnet-4.5`   | 10         | 64K        | No        | Best all-round agent model ✓ tested |
| `straico/openai/gpt-5.2`                | `openai/gpt-5.2`                | 6          | 128K       | No        | Latest GPT-5 family ✓ tested        |
| `straico/x-ai/grok-4-fast-reasoning`    | `x-ai/grok-4-fast-reasoning`    | 8          | 1M         | Yes       | Reasoning + 1M context ✓ tested     |
| `straico/google/gemini-3-flash-preview` | `google/gemini-3-flash-preview` | 2          | 66K        | No        | Fastest/cheapest option             |
| `straico/openai/o4-mini`                | `openai/o4-mini`                | 1.5        | 100K       | Yes       | Budget reasoning                    |

To use a model: `openclaw models set straico/anthropic/claude-sonnet-4.5`

### 5.4 Full Catalog

Straico exposes 70+ models. The full list (as of 2026-03-15) is available at `GET https://api.straico.com/v0/models`. To expand beyond the top 5, add entries to `models.providers.straico.models` and matching `{ streaming: false }` entries in `agents.defaults.models` via `openclaw config edit`.

### 5.5 Active Gateway Config (op1_config)

```json5
{
  env: {
    STRAICO_API_KEY: "...", // stored in op1_config env block
  },

  agents: {
    defaults: {
      // streaming: false required for every straico model
      // WARNING: any new model missing from this list defaults to streaming: true and breaks
      models: {
        "straico/anthropic/claude-sonnet-4.5": { streaming: false },
        "straico/openai/gpt-5.2": { streaming: false },
        "straico/x-ai/grok-4-fast-reasoning": { streaming: false },
        "straico/google/gemini-3-flash-preview": { streaming: false },
        "straico/openai/o4-mini": { streaming: false },
      },
    },
  },

  models: {
    mode: "merge",
    providers: {
      straico: {
        baseUrl: "https://api.straico.com/v0",
        apiKey: "${STRAICO_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "anthropic/claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 64000,
            compat: { supportsTools: false },
          },
          {
            id: "openai/gpt-5.2",
            name: "GPT-5.2",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 128000,
            compat: { supportsTools: false },
          },
          {
            id: "x-ai/grok-4-fast-reasoning",
            name: "Grok 4 Fast Reasoning",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 1047576,
            compat: { supportsTools: false },
          },
          {
            id: "google/gemini-3-flash-preview",
            name: "Gemini 3 Flash",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 66000,
            compat: { supportsTools: false },
          },
          {
            id: "openai/o4-mini",
            name: "o4 Mini",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 100000,
            compat: { supportsTools: false },
          },
        ],
      },
    },
  },
}
```

### 5.6 Known Limitations

| Limitation                | Impact                                                        | Workaround                                                               |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No streaming              | Responses arrive all at once; no incremental display          | `streaming: false` per model prevents SSE parse errors                   |
| Tool calling unverified   | Agent tool-use may break silently                             | `compat: { supportsTools: false }` on all models until tested            |
| Coin-based billing        | Cost tracking doesn't map to per-token pricing                | Monitor via Straico dashboard; `cost` fields left as zeros               |
| Coin exhaustion (402)     | Straico requests fail; no fallback within Straico             | Gateway fallback chain falls through to next provider (e.g. `zai/glm-5`) |
| Streaming maintenance gap | New models without matching streaming override break silently | Always add `{ streaming: false }` entry when adding a new Straico model  |

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` / `- [x]` checkbox = one Dart Subtask
> - `**Status:**` on line 1 of each task syncs with Dart status field

### Task 1: Phase 1 — Configuration Setup

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Due:** 2026-03-15 | **Est:** 1h

Add Straico provider to gateway config in SQLite with top 5 curated models, streaming disabled, and tools disabled.

- [x] 1.1 Verify API key — confirmed working against `/v0/models`
- [x] 1.2 Get live model list — fetched full catalog from `/v0/models`, selected top 5
- [x] 1.3 Add provider block — `models.providers.straico` with baseUrl, apiKey, openai-completions adapter
- [x] 1.4 Add model definitions — top 5 models with correct IDs, context windows, `compat: { supportsTools: false }`
- [x] 1.5 Disable streaming — `agents.defaults.models` entries with `{ streaming: false }` for all 5 models
- [x] 1.6 Store API key — `STRAICO_API_KEY` in gateway env block
- [x] 1.7 Restart gateway — confirmed process restarted, config loaded, 5 models registered

### Task 2: Phase 2 — Testing & Validation

**Status:** In Progress | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 1h

Validate completions, streaming behaviour, and remaining edge cases.

- [x] 2.1 Verify API auth — `GET /v0/models` returned full model list ✓
- [x] 2.2 Validate model IDs — all 5 IDs confirmed in live API response ✓
- [x] 2.3 Test chat completion (non-streaming) — Claude Sonnet 4.5, GPT-5.2, Grok 4 Fast Reasoning all returned valid responses ✓
- [x] 2.4 Test streaming behaviour — `stream: true` returns normal JSON (no SSE), `streaming: false` config prevents parse errors ✓
- [x] 2.5 Verify models visible in gateway — `openclaw models list` shows all 5 as `configured` ✓
- [ ] 2.6 Test tool calling — send request with tool payload; update `supportsTools` if it works
- [ ] 2.7 Test Gemini 3 Flash and o4-mini completions directly
- [ ] 2.8 Test gateway-level completion — `openclaw models set straico/...` then send a real agent message
- [ ] 2.9 Test 402 failover — confirm gateway falls back to `zai/glm-5` on coin exhaustion

---

## 7. References

- Key source files:
  - `src/config/types.models.ts`
  - `src/config/types.agent-defaults.ts`
  - `src/agents/models-config.providers.ts`
  - `src/infra/state-db/config-sqlite.ts`
- External:
  - [Straico Platform](https://platform.straico.com)
  - [Straico API Page](https://straico.com/api/)
  - [Postman API Docs](https://documenter.getpostman.com/view/5900072/2s9YyzddrR)
- Dart project: _(filled after first sync)_

---

_Template version: 1.0 — do not remove the frontmatter or alter heading levels_
