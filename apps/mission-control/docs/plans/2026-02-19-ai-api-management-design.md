# AI API Management — Hybrid Architecture Design

**Date:** 2026-02-19
**Status:** Approved
**Scope:** openclaw-mission-control (primary), openclaw-platform (secondary)

---

## Problem Statement

The Mission Control settings UI and the AI execution engine are completely disconnected. API keys saved in settings are stored in SQLite but never read by the chat API, agents, or orchestrator. All AI calls go through the OpenClaw Gateway (WebSocket at `ws://127.0.0.1:18789`), which maintains its own separate key configuration. The settings page is a dead-end database.

### Audit Findings Summary

**API Routes:**
- API keys stored as plaintext (column named `api_key_encrypted` but isn't)
- Credit/billing checks are 100% manual — no real provider API calls
- Azure OpenAI test URL points to wrong endpoint (management plane, not inference)
- LM Studio health check uses `/api/tags` instead of `/v1/models`

**Settings UI:**
- Ollama discovery broken — response shape mismatch (`ollama.available` vs `ollamaAvailable`)
- "Save & Test" button doesn't actually test
- `HelpCircle` icon aliased to `Info` after first use (wrong icon for "Untested")
- Model section never shows gateway-down warning (error catch is silent)
- No inline edit for API keys, no credit refresh, no provider help links

**Model/Agent Wiring:**
- `configPatch()` RPC already exists on OpenClawClient (line 966) but is never called
- Gateway URL/token from settings UI (localStorage) ignored by server (reads env vars only)
- Model preference stored client-side only (localStorage), not server-side
- Agent registry is prompt-only — no provider/model bindings

---

## Architecture: Hybrid Gateway + Direct Fallback

### Section 1: API Key Lifecycle

When a user adds an API key:

```
User enters key in Settings UI
    ↓
Frontend calls POST /api/settings/api-keys { provider, label, api_key, base_url }
    ↓
Backend:
  1. Test key against provider API (real HTTP call)
  2. If test FAILS → return error, do NOT save
  3. If test PASSES:
     a. Encrypt key with AES-256-GCM
     b. Store in SQLite api_keys table
     c. Push to gateway via client.configPatch()
     d. Return success + status
    ↓
On gateway sync failure:
  → Key is saved locally with status "gateway_sync_pending"
  → UI shows warning: "Saved locally, gateway sync pending"
  → Background retry on next settings page load
```

On DELETE:
- Remove from SQLite
- Remove from gateway via `configPatch()`
- Gateway sync failure is non-fatal (key is removed locally regardless)

On TOGGLE (active/inactive):
- Update SQLite
- Push updated state to gateway

### Section 2: Direct-to-Provider Fallback

When the gateway is unreachable, chat and agent tasks use stored API keys directly:

```
Chat message / Agent task
    ↓
Try gateway via WebSocket (3-second timeout)
    ↓
Gateway reachable?
  YES → Normal flow (gateway routes to provider)
  NO  → Direct mode:
        1. Read active, tested keys from SQLite
        2. Pick provider: user preference → Claude → GPT → Gemini → Ollama
        3. Call provider API directly (OpenAI SDK / Anthropic SDK / fetch)
        4. UI shows "Direct mode" indicator
```

Direct mode provider priority:
1. User's configured model preference (if provider has active key)
2. Anthropic (Claude) — if key exists
3. OpenAI (GPT) — if key exists
4. Google (Gemini) — if key exists
5. Ollama local — if running and model registered
6. Any other active provider

### Section 3: Settings UI Bug Fixes

**Critical bugs (must fix):**

| Bug | File | Fix |
|---|---|---|
| Ollama discovery broken | `local-models-section.tsx` / `settings-types.ts` / `models/route.ts` | Align response shape: route returns flat `ollamaAvailable`/`ollamaModels` to match type |
| "Save & Test" doesn't test | `api-keys-section.tsx` | Test first via PATCH, then save via POST on success |
| Wrong icon for Untested | `ai-api-command-center.tsx` | Move `HelpCircle` import before `ProviderCard` definition |
| Model section silent error | `ai-model-section.tsx` | Add error state, check `degraded` flag in response |
| Azure test URL wrong | `api-keys/route.ts` | Use deployment-specific endpoint pattern |
| LM Studio health check | `models/route.ts` | Use `/v1/models` for non-Ollama providers |

**UX improvements:**

| Improvement | Description |
|---|---|
| One-click Connect flow | Clicking "Connect" on provider card opens add form pre-populated with that provider |
| Inline key edit | PATCH support in UI — edit label, key, base_url without delete-recreate |
| Credit display | Show `balance` field, `last_checked_at` timestamp, manual refresh button |
| Provider help links | Each provider card links to its API key console page |
| Gateway token toggle | Add Eye/EyeOff show/hide like other secret fields |
| Debounced gateway settings | Save on blur/Enter, not on every keystroke |
| Provider documentation | Show "Get API key" links using PROVIDER_CREDIT_URLS or similar |

### Section 4: Ollama & Local AI Integration

**Auto-discovery flow:**
1. On settings page load, ping Ollama at configured URL (default `localhost:11434`)
2. Show discovered models with name, size, and parameter count
3. One-click "Register" adds to SQLite AND pushes to gateway
4. Configurable base URL (remove hardcoded `localhost:11434` from frontend)
5. Models under 14B flagged as "small" with performance note

**Registration flow:**
```
Ollama model detected (e.g., llama3.1:70b)
    ↓
User clicks "Register"
    ↓
POST /api/settings/models
    → Store in SQLite local_models
    → Push to gateway via configPatch()
    ↓
Model appears in:
    → Model selector dropdown
    → Direct mode fallback chain
    → Gateway model list
```

### Section 5: Provider Status Dashboard Widget

A persistent widget accessible from the main dashboard header:

**Compact mode (header bar):**
- Small colored dot: green (all good), yellow (issues), red (critical)
- Tooltip: "3/5 providers active"

**Expanded mode (click to expand):**
```
┌─ AI Provider Status ──────────────────────────┐
│  Gateway: 🟢 Connected    Mode: Hybrid         │
│                                                │
│  ● Anthropic    🟢 Active   $47.32 remaining  │
│  ● OpenAI       🟢 Active   $12.08 remaining  │
│  ● Google       🟡 Untested  —                 │
│  ● Ollama       🟢 Running  llama3.1:70b       │
│  ● xAI          🔴 Error    Key expired        │
│                                                │
│  [Manage Keys]  [Test All]  [Refresh Credits]  │
└────────────────────────────────────────────────┘
```

**Data source:**
- Reads from `/api/settings/api-keys/batch-status` (cached, refreshed every 60s)
- Gateway status from `/api/openclaw/status`
- Credit data from `/api/settings/credits`

---

## Files to Create/Modify

### New files:
- `src/lib/direct-provider.ts` — Direct-to-provider SDK wrappers (Anthropic, OpenAI, Google, Ollama)
- `src/lib/encryption.ts` — AES-256-GCM encrypt/decrypt for API keys
- `src/lib/gateway-sync.ts` — Push/pull API keys to/from gateway via configPatch()
- `src/components/ui/provider-status-widget.tsx` — Header status indicator + expanded widget

### Modified files:
- `src/app/api/settings/api-keys/route.ts` — Add test-before-save, encryption, gateway sync
- `src/app/api/settings/api-keys/batch-status/route.ts` — Sync ALL_PROVIDERS list
- `src/app/api/settings/credits/route.ts` — Add DELETE, add real credit fetch for supported providers
- `src/app/api/settings/models/route.ts` — Fix response shape, fix LM Studio health check
- `src/app/api/chat/route.ts` — Add direct mode fallback
- `src/app/api/tasks/dispatch/route.ts` — Add direct mode fallback
- `src/components/views/settings/ai-api-command-center.tsx` — Fix HelpCircle, add Connect pre-populate
- `src/components/views/settings/api-keys-section.tsx` — Fix Save & Test, add inline edit
- `src/components/views/settings/ai-model-section.tsx` — Fix error handling, show degraded state
- `src/components/views/settings/local-models-section.tsx` — Fix Ollama type mismatch, configurable URL
- `src/components/views/settings/settings-types.ts` — Add missing provider icons, sync provider lists
- `src/components/views/settings/gateway-section.tsx` — Debounce saves, add token toggle
- `src/components/views/settings-panel.tsx` — Wire provider status widget

---

## Out of Scope (for now)

- Platform backend (Python) agent orchestrator changes
- Real-time credit polling (background jobs)
- API key rotation / expiry alerts
- Multi-workspace key isolation
- OAuth flows for providers that support them (Google Cloud, Azure AD)
