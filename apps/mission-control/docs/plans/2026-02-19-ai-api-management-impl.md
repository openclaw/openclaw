# AI API Management — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bridge the settings UI to the AI execution engine so API keys saved in the dashboard are actually used by chat/agents, with a direct-to-provider fallback when the gateway is down.

**Architecture:** Hybrid gateway + direct fallback. Settings UI saves keys to SQLite (encrypted), pushes them to the gateway via `configPatch()` RPC. When the gateway is unreachable, chat/agent routes read keys from SQLite and call providers directly. A status widget in the main dashboard header shows provider health at a glance.

**Tech Stack:** Next.js 16, React 19, TypeScript, better-sqlite3, WebSocket (OpenClaw gateway), Node.js crypto (AES-256-GCM), Lucide icons, Tailwind CSS 4.

---

## Phase 1: Critical Bug Fixes (Settings UI)

These are independent fixes that unblock everything else. Each can be done and committed separately.

---

### Task 1: Fix Ollama Discovery Response Shape Mismatch

The API route returns `{ models, ollama: { available, models } }` but `LocalModelsSection` reads `data.ollamaAvailable` and `data.ollamaModels`. This breaks all Ollama auto-discovery in the UI.

**Files:**
- Modify: `src/app/api/settings/models/route.ts:79-82`
- Modify: `src/components/views/settings/settings-types.ts:56-60` (verify type matches)

**Step 1: Fix the API route to return flat shape matching the type**

In `src/app/api/settings/models/route.ts`, change lines 79-82 from:

```typescript
return NextResponse.json({
  models: registered,
  ollama: ollamaStatus,
});
```

to:

```typescript
return NextResponse.json({
  models: registered,
  ollamaAvailable: ollamaStatus.available,
  ollamaModels: ollamaStatus.models,
});
```

**Step 2: Verify the `LocalModelsData` type in `settings-types.ts` already matches**

Confirm that `settings-types.ts` lines 56-60 define:
```typescript
export interface LocalModelsData {
    models: LocalModelResponse[];
    ollamaAvailable: boolean;
    ollamaModels: OllamaModel[];
}
```

This should already be correct — the type was right, the route was wrong.

**Step 3: Build to check for compile errors**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`
Expected: Build succeeds (or pre-existing warnings only).

**Step 4: Commit**

```bash
git add src/app/api/settings/models/route.ts
git commit -m "fix: align Ollama discovery response shape with LocalModelsData type

The route returned { ollama: { available, models } } but the frontend
expected { ollamaAvailable, ollamaModels }. This broke all Ollama
auto-discovery in the local models settings section."
```

---

### Task 2: Fix "Save & Test" — Actually Test Before Save

The "Save & Test" button in `api-keys-section.tsx` only saves. It should test the key first, and only save if the test passes.

**Files:**
- Modify: `src/components/views/settings/api-keys-section.tsx:51-79` (handleAdd function)

**Step 1: Rewrite `handleAdd` to test first, then save on success**

Replace the `handleAdd` function (lines 51-79) with logic that:
1. Calls `PATCH /api/settings/api-keys` with `{ id: "test-only", provider, api_key, test: true }` to test
2. If test returns `status: "error"`, show error toast and do NOT save
3. If test returns `status: "active"`, proceed with `POST /api/settings/api-keys` to save
4. Show appropriate toasts for each outcome

The test endpoint already exists — `PATCH` with `body.test === true` calls the real provider API. We just need a temporary ID for the test call since it expects an `id`.

Actually, looking closer at the PATCH route — it looks up the key by ID first (`getApiKey(id)`), so we can't test a key that doesn't exist yet. We need to adjust the approach:

**Revised approach:** Save the key first (POST), then immediately test it (PATCH with `test: true`). If the test fails, notify the user but keep the key saved with `"error"` status so they can re-test later.

```typescript
const handleAdd = async () => {
    if (!newValue.trim()) return;
    setSaving(true);
    try {
        // 1. Save the key
        const saveRes = await fetch("/api/settings/api-keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                provider: newProvider,
                label: newLabel,
                api_key: newValue,
                base_url: newBaseUrl || null,
            }),
        });
        if (!saveRes.ok) throw new Error(`Save failed: HTTP ${saveRes.status}`);
        const saved = await saveRes.json();

        // 2. Test the key
        const testRes = await fetch("/api/settings/api-keys", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: saved.key?.id || saved.id, test: true }),
        });
        const testResult = testRes.ok ? await testRes.json() : null;
        const testStatus = testResult?.testResult?.status;

        // 3. Report result
        if (testStatus === "active") {
            addToast("success", `API key added and verified — ${newLabel} is active`);
        } else if (testStatus === "error") {
            addToast("warning", `API key saved but test failed — check your ${newLabel} key`);
        } else {
            addToast("success", "API key added (could not verify — provider may not support testing)");
        }

        await fetchApiKeys();
        setShowAddForm(false);
        setNewValue("");
        setNewBaseUrl("");
        setNewProvider(API_KEY_PROVIDERS[0].id);
        setNewLabel(API_KEY_PROVIDERS[0].name);
        setShowNewValue(false);
    } catch (err) {
        addToast("error", `Failed to save API key: ${err}`);
    } finally {
        setSaving(false);
    }
};
```

**Step 2: Update button label to reflect the actual behavior**

Change the button text from `"Save & Test"` to `"Add & Verify"` (since it now actually does both).

**Step 3: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 4: Commit**

```bash
git add src/components/views/settings/api-keys-section.tsx
git commit -m "fix: api key save now tests against provider after saving

Previously 'Save & Test' only saved. Now the key is saved first, then
immediately tested via the PATCH endpoint. Toast messages reflect the
actual test result (active, error, or untestable)."
```

---

### Task 3: Fix HelpCircle Icon Bug in Command Center

In `ai-api-command-center.tsx`, `HelpCircle` is used at line 169 for "Untested" status but aliased to `Info` later at line 266. The icon renders as a circle-i instead of a question mark.

**Files:**
- Modify: `src/components/views/settings/ai-api-command-center.tsx:1-18` (imports)

**Step 1: Add `HelpCircle` to the import list**

In the import block at the top of the file, add `HelpCircle` to the lucide-react import:

```typescript
import {
    Activity,
    AlertCircle,
    CheckCircle2,
    CreditCard,
    ExternalLink,
    HelpCircle,
    Info,
    Key,
    Loader2,
    Plus,
    RefreshCw,
    ShieldAlert,
    Sparkles,
    Zap
} from "lucide-react";
```

**Step 2: Remove the later alias**

Search for `const HelpCircle = Info` or similar alias later in the file and remove it.

**Step 3: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 4: Commit**

```bash
git add src/components/views/settings/ai-api-command-center.tsx
git commit -m "fix: use proper HelpCircle icon for untested provider status

HelpCircle was aliased to Info after its first usage, rendering a
circle-i icon instead of a question mark for untested providers."
```

---

### Task 4: Fix AI Model Section Silent Error and Degraded State

The model section catches errors silently and never shows the gateway-down warning.

**Files:**
- Modify: `src/components/views/settings/ai-model-section.tsx:19-49`

**Step 1: Add error state and degraded detection**

Add state variables and update the fetch function:

```typescript
const [error, setError] = useState<string | null>(null);
const [degraded, setDegraded] = useState(false);

const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
        const res = await fetch("/api/models");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ModelsResponse & { degraded?: boolean } = await res.json();
        setModelsData(data);
        setDegraded(!!data.degraded);

        // Restore saved preference
        const pref = getStoredModelPreference();
        if (pref) {
            setSelectedProvider(pref.provider);
            setSelectedModel(pref.model);
        } else {
            setSelectedProvider(data.defaultProvider || data.providers?.[0] || "");
            setSelectedModel(data.defaultModel || "");
        }
    } catch (err) {
        setError(String(err));
        setModelsData(null);
    } finally {
        setLoading(false);
    }
}, []);
```

**Step 2: Render error and degraded banners in the JSX**

After the loading check, add:

```tsx
{error && (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>Failed to load models: {error}</span>
        <button onClick={fetchModels} className="ml-auto text-xs underline">Retry</button>
    </div>
)}
{degraded && !error && (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-500 text-sm mb-4">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>Gateway unreachable — showing cached model catalog. Some models may be unavailable.</span>
    </div>
)}
```

**Step 3: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 4: Commit**

```bash
git add src/components/views/settings/ai-model-section.tsx
git commit -m "fix: show error and degraded state in AI model section

Previously errors were silently caught and the gateway-down warning
never displayed because the /api/models fallback returns 200 with
degraded: true. Now both states are properly surfaced to the user."
```

---

### Task 5: Fix Azure OpenAI Test URL

The test URL points to `management.azure.com` (management plane) instead of an inference endpoint.

**Files:**
- Modify: `src/app/api/settings/api-keys/route.ts:84-87`

**Step 1: Update the Azure OpenAI test config**

Replace the current Azure entry with a generic pattern that accepts a `base_url`:

```typescript
"azure-openai": {
    url: "", // Requires base_url — will use: {base_url}/openai/models?api-version=2024-06-01
    headers: (key) => ({ "api-key": key }),
},
```

**Step 2: Update `testProviderConnection` to handle Azure's base_url requirement**

In the `testProviderConnection` function, after the config lookup, add Azure-specific handling:

```typescript
if (provider === "azure-openai") {
    if (!baseUrl) {
        return { ok: false, status: "error", detail: "Azure OpenAI requires a base URL (e.g., https://your-resource.openai.azure.com)" };
    }
    url = `${baseUrl.replace(/\/$/, "")}/openai/models?api-version=2024-06-01`;
}
```

**Step 3: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 4: Commit**

```bash
git add src/app/api/settings/api-keys/route.ts
git commit -m "fix: use correct Azure OpenAI test endpoint

Was hitting management.azure.com (management plane) which requires
OAuth. Now uses the deployment-specific inference endpoint with
api-version parameter, requiring a base_url from the user."
```

---

### Task 6: Fix LM Studio Health Check Endpoint

The health check always uses Ollama's `/api/tags` endpoint, even for LM Studio models which use `/v1/models`.

**Files:**
- Modify: `src/app/api/settings/models/route.ts:123-150` (PATCH health check)

**Step 1: Add provider-aware health check function**

Add a new function above the PATCH handler:

```typescript
async function checkModelHealth(
    provider: string,
    baseUrl: string
): Promise<{ available: boolean }> {
    const endpoint = provider === "ollama"
        ? `${baseUrl}/api/tags`
        : `${baseUrl}/v1/models`; // LM Studio, vLLM, etc.

    try {
        const response = await fetch(endpoint, {
            signal: AbortSignal.timeout(5_000),
        });
        return { available: response.ok };
    } catch {
        return { available: false };
    }
}
```

**Step 2: Use the new function in the PATCH handler**

Replace line 135:
```typescript
const result = await fetchOllamaModels(existing.base_url);
```
with:
```typescript
const result = await checkModelHealth(existing.provider || "ollama", existing.base_url);
```

**Step 3: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 4: Commit**

```bash
git add src/app/api/settings/models/route.ts
git commit -m "fix: use provider-appropriate endpoint for local model health check

Ollama uses /api/tags, LM Studio and other OpenAI-compatible servers
use /v1/models. Previously all models were checked against /api/tags."
```

---

## Phase 2: Gateway Sync Bridge

Wire the settings UI to push API keys to the gateway when they're saved.

---

### Task 7: Create Gateway Sync Module

**Files:**
- Create: `src/lib/gateway-sync.ts`

**Step 1: Create the gateway sync module**

```typescript
/**
 * Gateway Sync — pushes API key changes from SQLite to the OpenClaw gateway
 * via the configPatch() RPC method.
 */
import { getOpenClawClient } from "@/lib/openclaw-client";
import structlog from "@/lib/log"; // or console if no structlog

const log = console; // Replace with structlog if available

export interface GatewaySyncResult {
    synced: boolean;
    error?: string;
}

/**
 * Push an API key to the gateway's provider configuration.
 */
export async function syncKeyToGateway(
    provider: string,
    apiKey: string,
    baseUrl?: string | null
): Promise<GatewaySyncResult> {
    try {
        const client = getOpenClawClient();
        await client.connect();

        // Build the config patch for this provider
        const providerConfig: Record<string, unknown> = {
            apiKey,
        };
        if (baseUrl) {
            providerConfig.baseUrl = baseUrl;
        }

        await client.configPatch({
            providers: {
                [provider]: providerConfig,
            },
        });

        return { synced: true };
    } catch (err) {
        log.warn("Gateway sync failed (non-fatal)", { provider, error: String(err) });
        return { synced: false, error: String(err) };
    }
}

/**
 * Remove an API key from the gateway's provider configuration.
 */
export async function removeKeyFromGateway(
    provider: string
): Promise<GatewaySyncResult> {
    try {
        const client = getOpenClawClient();
        await client.connect();

        await client.configPatch({
            providers: {
                [provider]: null, // Remove the provider
            },
        });

        return { synced: true };
    } catch (err) {
        log.warn("Gateway key removal failed (non-fatal)", { provider, error: String(err) });
        return { synced: false, error: String(err) };
    }
}

/**
 * Check if the gateway is reachable.
 */
export async function isGatewayReachable(): Promise<boolean> {
    try {
        const client = getOpenClawClient();
        await client.connect();
        return client.isConnected;
    } catch {
        return false;
    }
}
```

**Step 2: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 3: Commit**

```bash
git add src/lib/gateway-sync.ts
git commit -m "feat: add gateway sync module for pushing API keys to gateway

Provides syncKeyToGateway(), removeKeyFromGateway(), and
isGatewayReachable() using the existing configPatch() RPC method.
All gateway operations are non-fatal — failures are logged but
don't block the settings save."
```

---

### Task 8: Wire API Keys Route to Gateway Sync

**Files:**
- Modify: `src/app/api/settings/api-keys/route.ts`

**Step 1: Import gateway sync in the api-keys route**

Add at the top:
```typescript
import { syncKeyToGateway, removeKeyFromGateway } from "@/lib/gateway-sync";
```

**Step 2: Add gateway sync after POST (key creation)**

After the `createApiKey` call in the POST handler, add:

```typescript
// Push to gateway (non-fatal)
const gatewayResult = await syncKeyToGateway(
    data.provider,
    body.api_key,
    data.base_url
);
```

Include `gatewayResult` in the response JSON so the UI can show sync status.

**Step 3: Add gateway sync after PATCH (toggle active/inactive)**

When a key is toggled active, sync it to the gateway. When toggled inactive, remove it.

**Step 4: Add gateway removal on DELETE**

Before or after `deleteApiKey(id)`, call `removeKeyFromGateway(existing.provider)`.

**Step 5: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 6: Commit**

```bash
git add src/app/api/settings/api-keys/route.ts
git commit -m "feat: sync API key changes to gateway via configPatch

POST/PATCH/DELETE now push key changes to the gateway. Gateway sync
failures are non-fatal — keys are still saved locally and the UI
shows the sync status."
```

---

## Phase 3: Direct-to-Provider Fallback

When the gateway is unreachable, route chat/agent requests directly to providers using stored API keys.

---

### Task 9: Create Direct Provider Module

**Files:**
- Create: `src/lib/direct-provider.ts`

**Step 1: Create the direct provider module**

This module reads active API keys from SQLite and makes direct HTTP calls to AI providers when the gateway is down.

Key functions to implement:
- `getActiveProviderKey(provider: string)` — reads the best active key from SQLite for a provider
- `sendDirectMessage(message: string, options: { provider?, model?, systemPrompt? })` — sends a chat completion request directly to a provider API
- `getAvailableDirectProviders()` — lists which providers have active, tested keys

Supported provider APIs:
- OpenAI/compatible: `POST /v1/chat/completions` (OpenAI, Groq, Together, Fireworks, DeepSeek, Mistral, xAI, OpenRouter, Cerebras)
- Anthropic: `POST /v1/messages`
- Google: `POST /v1/models/{model}:generateContent`
- Ollama: `POST /api/chat`

The implementation should use a common `OpenAI-compatible` path for most providers (they all follow the same chat completions format) with specific handlers for Anthropic and Google.

**Step 2: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 3: Commit**

```bash
git add src/lib/direct-provider.ts
git commit -m "feat: add direct-to-provider module for gateway-down fallback

Reads active API keys from SQLite and calls provider APIs directly.
Supports OpenAI-compatible (most providers), Anthropic, Google, and
Ollama. Used when the gateway WebSocket is unreachable."
```

---

### Task 10: Wire Direct Fallback into Chat Route

**Files:**
- Modify: `src/app/api/chat/route.ts`

**Step 1: Add direct mode fallback**

In the POST handler, after the gateway `sendMessage` call fails and `isGatewayUnavailableError` returns true, instead of returning a 503, try the direct provider:

```typescript
import { sendDirectMessage, getAvailableDirectProviders } from "@/lib/direct-provider";
import { isGatewayReachable } from "@/lib/gateway-sync";

// In the POST handler, after gateway failure:
if (isGatewayUnavailableError(error)) {
    const directProviders = getAvailableDirectProviders();
    if (directProviders.length > 0) {
        const directResult = await sendDirectMessage(payload.message, {
            provider: payload.provider,
            model: payload.model,
            systemPrompt: agentPrompt,
        });
        return NextResponse.json({
            ...directResult,
            mode: "direct", // Signal to UI that this was a direct call
        });
    }
}
```

**Step 2: Build to verify**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`

**Step 3: Commit**

```bash
git add src/app/api/chat/route.ts
git commit -m "feat: add direct-to-provider fallback in chat route

When the gateway WebSocket is unreachable, chat messages are routed
directly to AI providers using API keys stored in the settings DB.
Response includes mode: 'direct' so the UI can indicate the fallback."
```

---

## Phase 4: Settings UX Improvements

---

### Task 11: One-Click Connect Flow (Pre-populate Add Form)

When clicking "Connect" on an unconfigured provider card in `AiApiCommandCenter`, auto-select that provider in the add form.

**Files:**
- Modify: `src/components/views/settings/ai-api-command-center.tsx`
- Modify: `src/components/views/settings/api-keys-section.tsx`

**Step 1: Pass a `defaultProvider` prop to `ApiKeysSection`**

In `AiApiCommandCenter`, track which provider the user clicked "Connect" on:
```typescript
const [connectProvider, setConnectProvider] = useState<string | null>(null);
```

On the "Connect" button click, set it:
```typescript
onClick={() => { setConnectProvider(providerId); setShowDetails(true); }}
```

Pass it down:
```tsx
<ApiKeysSection defaultProvider={connectProvider} onProviderHandled={() => setConnectProvider(null)} />
```

**Step 2: In `ApiKeysSection`, accept and use the prop**

When `defaultProvider` is set:
1. Auto-open the add form
2. Pre-select the provider in the dropdown
3. Set the label to the provider name
4. Focus the API key input field

**Step 3: Build and commit**

```bash
git add src/components/views/settings/ai-api-command-center.tsx src/components/views/settings/api-keys-section.tsx
git commit -m "feat: one-click Connect pre-populates API key add form

Clicking 'Connect' on an unconfigured provider card now opens the add
form with that provider pre-selected, saving the user from scrolling
and manually finding the right provider in the dropdown."
```

---

### Task 12: Inline Edit for Existing API Keys

**Files:**
- Modify: `src/components/views/settings/api-keys-section.tsx`

**Step 1: Add edit state and UI**

Add an `editingId` state. When a key row's edit button is clicked, expand it into an inline edit form with fields for label, API key (optional — leave blank to keep existing), and base URL. Submit via PATCH.

**Step 2: Build and commit**

```bash
git add src/components/views/settings/api-keys-section.tsx
git commit -m "feat: add inline edit for existing API keys

Users can now update label, key value, and base URL without
deleting and recreating the key. Uses the existing PATCH endpoint."
```

---

### Task 13: Credit Balance Display Improvements

**Files:**
- Modify: `src/components/views/settings/ai-api-command-center.tsx`

**Step 1: Show balance field and last_checked_at timestamp**

In the `ProviderCard` component, update the credit display:
- Show `creditInfo.balance` as currency amount (e.g., "$47.32 remaining")
- Show `creditInfo.last_checked_at` as relative time (e.g., "checked 2h ago")
- Show even when `limit_total` is null (usage-based billing)

**Step 2: Add manual refresh button per provider**

Add a small refresh icon button that calls `POST /api/settings/credits` with the provider name.

**Step 3: Build and commit**

```bash
git add src/components/views/settings/ai-api-command-center.tsx
git commit -m "feat: show credit balance and last-checked timestamp

Balance is now displayed even for providers without spending caps.
Each provider card shows when credits were last checked and has a
manual refresh button."
```

---

### Task 14: Provider Help Links

**Files:**
- Modify: `src/components/views/settings/settings-types.ts`
- Modify: `src/components/views/settings/ai-api-command-center.tsx`

**Step 1: Add `PROVIDER_KEY_URLS` constant**

In `settings-types.ts`, add a map from provider ID to the URL where users can create/manage their API key:

```typescript
export const PROVIDER_KEY_URLS: Record<string, string> = {
    openai: "https://platform.openai.com/api-keys",
    anthropic: "https://console.anthropic.com/settings/keys",
    google: "https://aistudio.google.com/app/apikey",
    xai: "https://console.x.ai/team/default/api-keys",
    groq: "https://console.groq.com/keys",
    mistral: "https://console.mistral.ai/api-keys",
    deepseek: "https://platform.deepseek.com/api_keys",
    openrouter: "https://openrouter.ai/settings/keys",
    fireworks: "https://fireworks.ai/api-keys",
    together: "https://api.together.xyz/settings/api-keys",
    cohere: "https://dashboard.cohere.com/api-keys",
    perplexity: "https://www.perplexity.ai/settings/api",
    cerebras: "https://cloud.cerebras.ai/platform/api-keys",
    huggingface: "https://huggingface.co/settings/tokens",
};
```

**Step 2: Show "Get API key" link on unconfigured provider cards**

In the provider card, add a small external link that opens the provider's key management page.

**Step 3: Build and commit**

```bash
git add src/components/views/settings/settings-types.ts src/components/views/settings/ai-api-command-center.tsx
git commit -m "feat: add 'Get API key' links to provider cards

Each unconfigured provider card now links directly to the provider's
API key management page, reducing friction for first-time setup."
```

---

### Task 15: Gateway Settings UX Fixes

**Files:**
- Modify: `src/components/views/settings/gateway-section.tsx`

**Step 1: Debounce gateway URL and token saves**

Replace `onChange` → `updateSettings` with local state + save on blur/Enter:

```typescript
const [localUrl, setLocalUrl] = useState(settings.gatewayUrl);
const [localToken, setLocalToken] = useState(settings.gatewayToken);

// Save on blur or Enter
const handleSaveUrl = () => updateSettings({ gatewayUrl: localUrl });
const handleSaveToken = () => updateSettings({ gatewayToken: localToken });
```

**Step 2: Add show/hide toggle for gateway token**

Add `showToken` state and an Eye/EyeOff toggle button, matching the pattern in `api-keys-section.tsx`.

**Step 3: Build and commit**

```bash
git add src/components/views/settings/gateway-section.tsx
git commit -m "feat: debounce gateway settings and add token show/hide

Settings now save on blur/Enter instead of every keystroke. Gateway
token field now has a show/hide toggle matching other secret fields."
```

---

## Phase 5: Provider Status Dashboard Widget

---

### Task 16: Create Provider Status Widget Component

**Files:**
- Create: `src/components/ui/provider-status-widget.tsx`

**Step 1: Create the widget component**

A component with two modes:
- **Compact**: A colored dot (green/yellow/red) with tooltip showing "N/M providers active"
- **Expanded**: Full provider list with status badges, balances, and quick actions

The widget fetches from:
- `/api/settings/api-keys/batch-status` (provider health)
- `/api/openclaw/status` (gateway connectivity)
- `/api/settings/credits` (balances)

Auto-refreshes every 60 seconds.

**Step 2: Build and commit**

```bash
git add src/components/ui/provider-status-widget.tsx
git commit -m "feat: add provider status dashboard widget

Compact dot indicator for the header bar, expandable to show all
provider health, balances, and gateway connectivity. Auto-refreshes
every 60 seconds."
```

---

### Task 17: Wire Status Widget into Dashboard Header

**Files:**
- Modify: `src/components/views/header.tsx` (or wherever the main header lives)

**Step 1: Find the header component**

Search for the main dashboard header/nav bar that contains the logo, theme toggle, and other controls.

**Step 2: Add the status widget**

Import and render `<ProviderStatusWidget />` in the header bar, positioned near other status indicators.

**Step 3: Build and commit**

```bash
git add src/components/views/header.tsx
git commit -m "feat: add AI provider status indicator to dashboard header

Compact colored dot shows overall provider health. Click to expand
full provider list with status, balances, and quick actions."
```

---

## Phase 6: Sync Provider Lists & Final Polish

---

### Task 18: Sync Provider Constants Across Codebase

**Files:**
- Modify: `src/components/views/settings/settings-types.ts`
- Modify: `src/app/api/settings/api-keys/batch-status/route.ts`

**Step 1: Add missing provider icons**

Add entries for `kimi-coding`, `minimax`, `minimax-cn`, `opencode`, `vercel-ai-gateway`, `zai` to `PROVIDER_ICONS`.

**Step 2: Sync `ALL_PROVIDERS` in batch-status with `API_KEY_PROVIDERS`**

Ensure both lists contain the same set of providers. Add `ollama` to both where appropriate.

**Step 3: Add `amazon-bedrock` and `github-copilot` to `PROVIDER_TEST_CONFIGS`**

For `amazon-bedrock`: requires a different auth pattern (AWS Signature V4), mark as `untestable` with a clear message.
For `github-copilot`: use `https://api.github.com/copilot_internal/v2/token` or mark as untestable.

**Step 4: Build and commit**

```bash
git add src/components/views/settings/settings-types.ts src/app/api/settings/api-keys/batch-status/route.ts src/app/api/settings/api-keys/route.ts
git commit -m "fix: sync provider lists across codebase

ALL_PROVIDERS, API_KEY_PROVIDERS, PROVIDER_ICONS, and
PROVIDER_TEST_CONFIGS now cover the same set of providers.
Added missing icons and test configs."
```

---

### Task 19: Fix Ollama Base URL Hardcoding in Frontend

**Files:**
- Modify: `src/components/views/settings/local-models-section.tsx`

**Step 1: Use configured base URL instead of hardcoded localhost**

Replace the hardcoded `http://localhost:11434` in the `handleRegisterOllama` call (line ~60) with the URL from the Ollama status response or a user-configurable field.

Add a "Ollama URL" input field above the model grid that defaults to `http://localhost:11434` but can be changed for remote Ollama instances.

**Step 2: Build and commit**

```bash
git add src/components/views/settings/local-models-section.tsx
git commit -m "feat: make Ollama base URL configurable in local models UI

Previously hardcoded to localhost:11434. Users running Ollama on a
different port or remote host can now configure the URL directly."
```

---

### Task 20: Final Build Verification and Integration Test

**Step 1: Full build**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npx next build`
Expected: Clean build, no type errors.

**Step 2: Run existing tests**

Run: `cd /Users/tg/Projects/OpenClaw/openclaw-mission-control && npm run test:api-contract`
Expected: All existing API contract tests pass.

**Step 3: Manual smoke test checklist**

Start the dev server: `npm run dev`

Test these flows:
- [ ] Settings → API Keys → Add a new key → verify it tests and saves
- [ ] Settings → API Keys → Edit an existing key
- [ ] Settings → API Keys → Delete a key
- [ ] Settings → Local Models → Ollama auto-discovery shows models (if Ollama running)
- [ ] Settings → Local Models → Register an Ollama model
- [ ] Settings → AI Model → Shows error banner when gateway is down
- [ ] Settings → AI Model → Shows degraded warning when using catalog fallback
- [ ] Settings → Gateway → URL saves on blur, not on keystroke
- [ ] Settings → Gateway → Token show/hide toggle works
- [ ] Header → Provider status dot is visible
- [ ] Header → Click dot → expanded provider list shows
- [ ] Provider cards → "Connect" pre-populates add form
- [ ] Provider cards → "Get API key" link opens provider console

**Step 4: Commit any remaining fixes**

```bash
git commit -m "fix: address issues found during integration testing"
```

---

## Summary: 20 Tasks in 6 Phases

| Phase | Tasks | Focus |
|---|---|---|
| 1. Bug Fixes | 1-6 | Fix Ollama discovery, Save & Test, icons, model errors, Azure test URL, LM Studio health |
| 2. Gateway Sync | 7-8 | Create gateway sync module, wire into API keys route |
| 3. Direct Fallback | 9-10 | Create direct provider module, wire into chat route |
| 4. UX Improvements | 11-15 | Connect flow, inline edit, credits, help links, gateway debounce |
| 5. Status Widget | 16-17 | Create widget, wire into dashboard header |
| 6. Polish | 18-20 | Sync constants, fix Ollama URL, final verification |

Tasks within a phase are sequential. Phases 1-3 are sequential (each builds on the previous). Phases 4 and 5 can run in parallel after Phase 2.
