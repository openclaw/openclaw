import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-model-metadata";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { TOKEN_SHARING_AUTH_FLOW, TOKEN_SHARING_RESOURCE } from "./token-sharing.js";

/** SIWC model discovery uses the already-prepared inference profile, never Codex auth. */
export async function buildTokenSharingCatalog(params: {
  auth: ReturnType<ProviderCatalogContext["resolveProviderAuth"]>;
  models: readonly ModelDefinitionConfig[];
  signal?: AbortSignal;
}): Promise<ProviderCatalogResult> {
  const { auth } = params;
  const sharing = auth.authFlow === TOKEN_SHARING_AUTH_FLOW;
  let models = sharing ? params.models.filter((model) => model.api === "openai-responses") : [];
  let status: ProviderCatalogOutcome["status"] = sharing ? "unavailable" : "auth-rejected";
  let rejectionScope: ProviderCatalogOutcome["rejectionScope"];
  const discoveryApiKey = auth.preparationFailed
    ? undefined
    : (auth.discoveryApiKey ??
      (auth.apiKey && !isNonSecretApiKeyMarker(auth.apiKey) ? auth.apiKey : undefined));
  if (sharing && discoveryApiKey) {
    try {
      const rows = await getCachedLiveProviderModelRows({
        providerId: "openai",
        endpoint: `${TOKEN_SHARING_RESOURCE}/models`,
        discoveryApiKey,
        signal: params.signal,
        ttlMs: 60_000,
        auditContext: "openai-model-discovery",
        readRows: (body) => {
          const bodyModels = asOptionalRecord(body)?.models;
          if (!Array.isArray(bodyModels)) {
            throw new Error("SIWC model discovery response must be { models: [] }");
          }
          return bodyModels;
        },
      });
      // A successful account list owns visibility, display names and order.
      // Bundled metadata can enrich a choice, but cannot invent account access.
      const metadata = new Map(models.map((model) => [model.id, model]));
      models = rows.flatMap((row): ModelDefinitionConfig[] => {
        const record = asOptionalRecord(row);
        const id = normalizeOptionalString(record?.slug);
        if (record?.visibility !== "list" || !id) {
          return [];
        }
        return [
          {
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: DEFAULT_CONTEXT_TOKENS,
            maxTokens: 128_000,
            ...metadata.get(id),
            id,
            name: normalizeOptionalString(record.display_name) ?? id,
            api: "openai-responses",
            baseUrl: TOKEN_SHARING_RESOURCE,
          },
        ];
      });
      status = "ready";
    } catch (error) {
      if (
        error instanceof LiveModelCatalogHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        models = [];
        status = "auth-rejected";
        // A catalog 403 does not establish that the inference credential is invalid.
        rejectionScope = error.status === 403 ? "catalog" : undefined;
      }
      // Temporary discovery failures retain static hints, explicitly unavailable.
    }
  }
  return {
    providers: {
      openai: { baseUrl: TOKEN_SHARING_RESOURCE, api: "openai-responses", models },
    },
    outcomes: [
      {
        provider: "openai",
        profileId: auth.profileId,
        status,
        ...(rejectionScope ? { rejectionScope } : {}),
        ...(status === "ready" ? { modelOrder: models.map(({ id }) => id) } : {}),
      },
    ],
  };
}
