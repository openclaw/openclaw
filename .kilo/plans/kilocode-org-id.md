# Implement ORG_ID for Kilocode provider (chat + embedding + model discovery)

## Background

In the OpenCode/Kilocode project, `ORG_ID` is sent as an `X-KILOCODE-ORGANIZATIONID` header on every request (chat, embedding, model fetch) and changes the model discovery URL to an org-scoped endpoint. In OpenClaw, this is completely missing — no env var, no config field, no header injection.

## Resolution sources (priority high → low)

1. Provider config headers: `models.providers.kilocode.headers["X-KILOCODE-ORGANIZATIONID"]`
2. Env var: `KILOCODE_ORG_ID`

A shared `resolveKilocodeOrgId()` helper in `kilocode-shared.ts` will encapsulate this resolution.

---

## Changes

### 1. `src/providers/kilocode-shared.ts` — Add ORG_ID constants and resolver

Add constants and a resolver function:

```ts
export const KILOCODE_ORG_ID_HEADER = "X-KILOCODE-ORGANIZATIONID";
export const KILOCODE_ORG_ID_ENV_VAR = "KILOCODE_ORG_ID";

/**
 * Resolve the Kilocode organization ID.
 * Provider config headers take precedence over env var.
 */
export function resolveKilocodeOrgId(providerConfig?: {
  headers?: Record<string, unknown>;
}): string | undefined {
  const fromHeaders = providerConfig?.headers?.[KILOCODE_ORG_ID_HEADER];
  if (typeof fromHeaders === "string" && fromHeaders.trim()) {
    return fromHeaders.trim();
  }
  const fromEnv = process.env[KILOCODE_ORG_ID_ENV_VAR]?.trim();
  return fromEnv || undefined;
}
```

### 2. `src/agents/pi-embedded-runner/proxy-stream-wrappers.ts` — Inject ORG_ID header in chat

Update `resolveKilocodeAppHeaders()` to accept optional orgId and inject the header:

```ts
import {
  KILOCODE_ORG_ID_HEADER,
  KILOCODE_ORG_ID_ENV_VAR,
} from "../../providers/kilocode-shared.js";

function resolveKilocodeAppHeaders(orgId?: string): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  const headers: Record<string, string> = { [KILOCODE_FEATURE_HEADER]: feature };
  const effectiveOrgId = orgId || process.env[KILOCODE_ORG_ID_ENV_VAR]?.trim();
  if (effectiveOrgId) {
    headers[KILOCODE_ORG_ID_HEADER] = effectiveOrgId;
  }
  return headers;
}
```

Update `createKilocodeWrapper()` to accept and pass along orgId:

```ts
export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
  orgId?: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...resolveKilocodeAppHeaders(orgId),
      },
      onPayload: (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}
```

### 3. `src/agents/pi-embedded-runner/extra-params.ts` — Thread ORG_ID to wrapper

In `applyExtraParamsToAgent()`, resolve org ID from config and pass to `createKilocodeWrapper`:

```ts
import { resolveKilocodeOrgId } from "../../providers/kilocode-shared.js";

// At line ~410 (kilocode block):
if (provider === "kilocode") {
  log.debug(`applying Kilocode feature header for ${provider}/${modelId}`);
  const kilocodeOrgId = resolveKilocodeOrgId(
    cfg?.models?.providers?.kilocode as { headers?: Record<string, unknown> } | undefined,
  );
  const kilocodeThinkingLevel =
    modelId === "kilo/auto" || isProxyReasoningUnsupported(modelId) ? undefined : thinkingLevel;
  agent.streamFn = createKilocodeWrapper(agent.streamFn, kilocodeThinkingLevel, kilocodeOrgId);
}
```

### 4. `src/memory/embeddings-kilocode.ts` — Inject ORG_ID header in embeddings

In `resolveKilocodeEmbeddingClient()`, inject the org ID header:

```ts
import {
  KILOCODE_BASE_URL,
  KILOCODE_ORG_ID_HEADER,
  resolveKilocodeOrgId,
} from "../providers/kilocode-shared.js";

// In resolveKilocodeEmbeddingClient, after building headers:
const orgId = resolveKilocodeOrgId(
  providerConfig as { headers?: Record<string, unknown> } | undefined,
);
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
  ...headerOverrides,
  [KILOCODE_FEATURE_HEADER]: KILOCODE_FEATURE_VALUE,
  ...(orgId ? { [KILOCODE_ORG_ID_HEADER]: orgId } : {}),
};
```

### 5. `src/agents/kilocode-models.ts` — Org-scoped model discovery URL

Update `discoverKilocodeModels()` to use org-scoped URL when org ID is available:

```ts
import { resolveKilocodeOrgId } from "../providers/kilocode-shared.js";

export async function discoverKilocodeModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  const orgId = resolveKilocodeOrgId();
  // Org-scoped URL pattern from opencode: /api/organizations/{orgId}/models
  // Default URL: {KILOCODE_BASE_URL}models (= .../api/gateway/models)
  const modelsUrl = orgId
    ? `${KILOCODE_BASE_URL.replace(/gateway\/?$/, "")}organizations/${orgId}/models`
    : KILOCODE_MODELS_URL;

  try {
    const response = await fetch(modelsUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    // ... rest unchanged
  }
}
```

### 6. `src/config/io.ts` — Register env var in allowlist

Add `"KILOCODE_ORG_ID"` to the env var allowlist (near line 73 where `KILOCODE_API_KEY` is listed).

### 7. Tests

#### `src/agents/pi-embedded-runner/extra-params.kilocode.test.ts`

- "injects X-KILOCODE-ORGANIZATIONID when KILOCODE_ORG_ID env var is set"
- "does not inject X-KILOCODE-ORGANIZATIONID when env var is unset"
- "injects X-KILOCODE-ORGANIZATIONID from config orgId when provided"

#### `src/memory/embeddings-kilocode.test.ts`

- "includes X-KILOCODE-ORGANIZATIONID header when org ID is available via env"
- "omits X-KILOCODE-ORGANIZATIONID header when org ID is not set"

#### `src/agents/kilocode-models.test.ts`

- "uses org-scoped URL when KILOCODE_ORG_ID is set"
- "uses default URL when KILOCODE_ORG_ID is not set"

---

## Files Modified

1. `src/providers/kilocode-shared.ts` — Add constants + resolver
2. `src/agents/pi-embedded-runner/proxy-stream-wrappers.ts` — ORG_ID in chat headers
3. `src/agents/pi-embedded-runner/extra-params.ts` — Pass org ID to wrapper
4. `src/memory/embeddings-kilocode.ts` — ORG_ID in embedding headers
5. `src/agents/kilocode-models.ts` — Org-scoped model discovery URL
6. `src/config/io.ts` — Register KILOCODE_ORG_ID env var
7. `src/agents/pi-embedded-runner/extra-params.kilocode.test.ts` — Chat ORG_ID tests
8. `src/memory/embeddings-kilocode.test.ts` — Embedding ORG_ID tests
9. `src/agents/kilocode-models.test.ts` — Model discovery ORG_ID tests
