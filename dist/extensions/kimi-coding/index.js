import { c as normalizeOptionalString } from "../../string-coerce-DyL154ka.js";
import { c as isRecord } from "../../utils-sBTEdeml.js";
import { r as normalizeProviderId } from "../../provider-id-zTW9Rdln.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-E_5Yag4W.js";
import "../../provider-auth-api-key-C06h8GOX.js";
import { a as normalizeKimiCodingModelId, i as buildKimiCodingProvider } from "../../provider-catalog-nrg9oGFW.js";
import { r as applyKimiCodeConfig, t as KIMI_CODING_MODEL_REF } from "../../onboard-C0ZXpwb2.js";
import { t as KIMI_REPLAY_POLICY } from "../../replay-policy-Nzl7UaSb.js";
import { a as wrapKimiProviderStream } from "../../stream-BD8nlCXf.js";
//#region extensions/kimi-coding/index.ts
const PLUGIN_ID = "kimi";
const PROVIDER_ID = "kimi";
function findExplicitProviderConfig(providers, providerId) {
	if (!providers) return;
	const normalizedProviderId = normalizeProviderId(providerId);
	const match = Object.entries(providers).find(([configuredProviderId]) => normalizeProviderId(configuredProviderId) === normalizedProviderId);
	return isRecord(match?.[1]) ? match[1] : void 0;
}
var kimi_coding_default = definePluginEntry({
	id: PLUGIN_ID,
	name: "Kimi Provider",
	description: "Bundled Kimi provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Kimi",
			aliases: ["kimi-code", "kimi-coding"],
			docsPath: "/providers/moonshot",
			envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Kimi Code API key (subscription)",
				hint: "Kimi K2.6 + Kimi",
				optionKey: "kimiCodeApiKey",
				flagName: "--kimi-code-api-key",
				envVar: "KIMI_API_KEY",
				promptMessage: "Enter Kimi API key",
				defaultModel: KIMI_CODING_MODEL_REF,
				expectedProviders: [
					"kimi",
					"kimi-code",
					"kimi-coding"
				],
				applyConfig: (cfg) => applyKimiCodeConfig(cfg),
				noteMessage: ["Kimi uses a dedicated coding endpoint and API key.", "Get your API key at: https://www.kimi.com/code/en"].join("\n"),
				noteTitle: "Kimi",
				wizard: {
					choiceId: "kimi-code-api-key",
					choiceLabel: "Kimi Code API key (subscription)",
					groupId: "moonshot",
					groupLabel: "Moonshot AI (Kimi K2.6)",
					groupHint: "Kimi K2.6"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					const explicitProvider = findExplicitProviderConfig(ctx.config.models?.providers, PROVIDER_ID);
					const builtInProvider = buildKimiCodingProvider();
					const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";
					const explicitHeaders = isRecord(explicitProvider?.headers) ? explicitProvider.headers : void 0;
					return { provider: {
						...builtInProvider,
						...explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {},
						...explicitHeaders ? { headers: {
							...builtInProvider.headers,
							...explicitHeaders
						} } : {},
						apiKey
					} };
				}
			},
			buildReplayPolicy: () => KIMI_REPLAY_POLICY,
			normalizeResolvedModel: ({ model }) => {
				const normalizedId = normalizeKimiCodingModelId(model.id);
				return normalizedId === model.id ? void 0 : {
					...model,
					id: normalizedId
				};
			},
			resolveThinkingProfile: () => ({
				levels: [{
					id: "off",
					label: "off"
				}, {
					id: "low",
					label: "on"
				}],
				defaultLevel: "off"
			}),
			wrapStreamFn: wrapKimiProviderStream
		});
	}
});
//#endregion
export { kimi_coding_default as default };
