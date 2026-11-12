import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { RERANK_DECISION_CAPABILITIES } from "./decision-codec.js";
import { buildRerankDecisionProvider, RERANK_PROVIDER_ID } from "./decision-provider.js";

export default definePluginEntry({
  id: "rerank",
  name: "Rerank Provider",
  description: "Use any /rerank endpoint as a Decision model",
  register(api) {
    api.registerProvider({
      id: RERANK_PROVIDER_ID,
      label: "Rerank",
      docsPath: "/providers/rerank",
      envVars: ["RERANK_API_KEY"],
      auth: [],
      // Self-hosted rerank servers usually need no credential. A configured
      // endpoint without a key resolves to the non-secret local marker, which
      // the transport never sends.
      resolveSyntheticAuth: ({ providerConfig }) =>
        providerConfig?.baseUrl
          ? {
              apiKey: CUSTOM_LOCAL_AUTH_MARKER,
              source: `models.providers.${RERANK_PROVIDER_ID} (no credential)`,
              mode: "api-key",
            }
          : undefined,
      // Configured rows only list a model id; declare what a reranker answers
      // unless the operator authored its own Decision facts. Never chat.
      augmentModelCatalog: ({ entries }) =>
        entries.flatMap((entry) =>
          entry.provider === RERANK_PROVIDER_ID && !entry.inference?.decision
            ? [{ ...entry, inference: { chat: false, decision: RERANK_DECISION_CAPABILITIES } }]
            : [],
        ),
    });
    api.registerDecisionProvider(buildRerankDecisionProvider());
  },
});
