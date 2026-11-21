import { buildManifestProviderCatalogFamily } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";
export const TOKENPLAN_PROVIDER_ID = "tencent-tokenplan";

export const TENCENT_PROVIDER_CATALOG = buildManifestProviderCatalogFamily({
  docsPath: "/providers/tencent",
  surfaces: (
    [
      { id: TOKENHUB_PROVIDER_ID, label: "Tencent TokenHub" },
      { id: TOKENPLAN_PROVIDER_ID, label: "Tencent TokenPlan" },
    ] as const
  ).map(({ id, label }) => {
    const catalog = manifest.modelCatalog.providers[id];
    return {
      id,
      label,
      catalog: {
        ...catalog,
        models: catalog.models.map((model) =>
          Object.assign({}, model, { api: "openai-completions" }),
        ),
      },
    };
  }),
});

const TOKENHUB_PROVIDER = TENCENT_PROVIDER_CATALOG.entries[0]!;
const TOKENPLAN_PROVIDER = TENCENT_PROVIDER_CATALOG.entries[1]!;

export const TOKENHUB_BASE_URL = TOKENHUB_PROVIDER.baseUrl;
export const TOKENPLAN_BASE_URL = TOKENPLAN_PROVIDER.baseUrl;
export const TOKENHUB_MODEL_CATALOG = TOKENHUB_PROVIDER.models;
export const TOKENPLAN_MODEL_CATALOG = TOKENPLAN_PROVIDER.models;
export const buildTokenHubProvider = TOKENHUB_PROVIDER.buildProvider;
export const buildTokenPlanProvider = TOKENPLAN_PROVIDER.buildProvider;
