import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export {
	ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
	buildAnthropicVertexProvider,
} from "./provider-catalog.js";
export {
	hasAnthropicVertexAvailableAuth,
	hasAnthropicVertexCredentials,
	resolveAnthropicVertexClientRegion,
	resolveAnthropicVertexConfigApiKey,
	resolveAnthropicVertexProjectId,
	resolveAnthropicVertexRegion,
	resolveAnthropicVertexRegionFromBaseUrl,
} from "./region.js";

import { buildAnthropicVertexProvider } from "./provider-catalog.js";
import { hasAnthropicVertexAvailableAuth } from "./region.js";

export function mergeImplicitAnthropicVertexProvider(params: {
	existing: ModelProviderConfig | undefined;
	implicit: ModelProviderConfig;
}): ModelProviderConfig {
	const { existing, implicit } = params;
	if (!existing) {
		return implicit;
	}
	return {
		...implicit,
		...existing,
		models:
			Array.isArray(existing.models) && existing.models.length > 0
				? existing.models
				: implicit.models,
	};
}

export function resolveImplicitAnthropicVertexProvider(params?: {
	env?: NodeJS.ProcessEnv;
}): ModelProviderConfig | null {
	const env = params?.env ?? process.env;
	if (!hasAnthropicVertexAvailableAuth(env)) {
		return null;
	}

	return buildAnthropicVertexProvider({ env });
}
