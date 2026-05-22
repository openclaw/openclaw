import { n as NATIVE_ANTHROPIC_REPLAY_HOOKS } from "../../provider-model-shared-EoaoyeJq.js";
import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { r as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-CsCNdUte.js";
import { i as resolveAnthropicVertexConfigApiKey, t as hasAnthropicVertexAvailableAuth } from "../../region-BAD70IYt.js";
import { i as resolveImplicitAnthropicVertexProvider, r as mergeImplicitAnthropicVertexProvider } from "../../api-IcAv0bMt.js";
//#region extensions/anthropic-vertex/index.ts
const PROVIDER_ID = "anthropic-vertex";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
var anthropic_vertex_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "Anthropic Vertex Provider",
	description: "Bundled Anthropic Vertex provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Anthropic Vertex",
			docsPath: "/providers/models",
			auth: [],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const implicit = resolveImplicitAnthropicVertexProvider({ env: ctx.env });
					if (!implicit) return null;
					return { provider: mergeImplicitAnthropicVertexProvider({
						existing: ctx.config.models?.providers?.[PROVIDER_ID],
						implicit
					}) };
				}
			},
			resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
			...NATIVE_ANTHROPIC_REPLAY_HOOKS,
			resolveSyntheticAuth: () => {
				if (!hasAnthropicVertexAvailableAuth()) return;
				return {
					apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
					source: "gcp-vertex-credentials (ADC)",
					mode: "api-key"
				};
			},
			augmentModelCatalog: ({ config }) => readConfiguredProviderCatalogEntries({
				config,
				providerId: PROVIDER_ID
			})
		});
	}
});
//#endregion
export { anthropic_vertex_default as default };
