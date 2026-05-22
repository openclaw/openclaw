import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-CMMgmetU.js";
import "./provider-auth-api-key-Byo72YCi.js";
import { t as GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks-d2MwtRXd.js";
import { n as resolveGoogleGeminiForwardCompatModel, t as isModernGoogleModel } from "./provider-models-C0O1RQrr.js";
import { n as normalizeGoogleModelId } from "./model-id-Bc7cVsyU2.js";
import { n as applyGoogleGeminiModelDefault, t as GOOGLE_GEMINI_DEFAULT_MODEL } from "./onboard-D7YeZki5.js";
import { a as normalizeGoogleProviderConfig, s as resolveGoogleGenerativeAiTransport } from "./provider-policy-Cnwr-lle.js";
import { t as hasGoogleVertexAuthorizedUserAdcSync } from "./vertex-adc-De0umL15.js";
import { i as createGoogleVertexTransportStreamFn, r as createGoogleGenerativeAiTransportStreamFn } from "./transport-stream-DgPNQdcK.js";
//#region extensions/google/provider-registration.ts
function buildGoogleProvider() {
	return {
		id: "google",
		label: "Google AI Studio",
		docsPath: "/providers/models",
		hookAliases: ["google-antigravity", "google-vertex"],
		envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		auth: [createProviderApiKeyAuthMethod({
			providerId: "google",
			methodId: "api-key",
			label: "Google Gemini API key",
			hint: "AI Studio / Gemini API key",
			optionKey: "geminiApiKey",
			flagName: "--gemini-api-key",
			envVar: "GEMINI_API_KEY",
			promptMessage: "Enter Gemini API key",
			defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
			expectedProviders: ["google"],
			applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
			wizard: {
				choiceId: "gemini-api-key",
				choiceLabel: "Google Gemini API key",
				groupId: "google",
				groupLabel: "Google",
				groupHint: "Gemini API key + OAuth"
			}
		})],
		normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({
			api,
			baseUrl
		}),
		normalizeConfig: ({ provider, providerConfig }) => normalizeGoogleProviderConfig(provider, providerConfig),
		normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
		resolveDynamicModel: (ctx) => resolveGoogleGeminiForwardCompatModel({
			providerId: ctx.provider,
			ctx
		}),
		createStreamFn: ({ model }) => {
			if (model.api === "google-generative-ai") return createGoogleGenerativeAiTransportStreamFn();
			if (model.api === "google-vertex" && hasGoogleVertexAuthorizedUserAdcSync()) return createGoogleVertexTransportStreamFn();
		},
		...GOOGLE_GEMINI_PROVIDER_HOOKS,
		isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId)
	};
}
function registerGoogleProvider(api) {
	api.registerProvider(buildGoogleProvider());
}
//#endregion
export { registerGoogleProvider as n, buildGoogleProvider as t };
