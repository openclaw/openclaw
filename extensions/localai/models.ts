import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { LOCALAI_DEFAULT_BASE_URL, LOCALAI_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildLocalaiProvider(params?: {
	baseUrl?: string;
	apiKey?: string;
}): Promise<ProviderConfig> {
	const baseUrl = (params?.baseUrl?.trim() || LOCALAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const models = await discoverOpenAICompatibleLocalModels({
		baseUrl,
		apiKey: params?.apiKey,
		label: LOCALAI_PROVIDER_LABEL,
	});
	return {
		baseUrl,
		api: "openai-completions",
		models,
	};
}
