import { r as resolvePluginConfigObject } from "./plugin-config-runtime-CJkf30el.js";
import { a as mergeImplicitMantleProvider, c as resolveImplicitMantleProvider, l as resolveMantleBearerToken, u as resolveMantleRuntimeBearerToken } from "./discovery-CmTVxfmz.js";
import { t as createMantleAnthropicStreamFn } from "./mantle-anthropic.runtime.js";
//#region extensions/amazon-bedrock-mantle/register.sync.runtime.ts
function registerBedrockMantlePlugin(api) {
	const providerId = "amazon-bedrock-mantle";
	const startupPluginConfig = api.pluginConfig ?? {};
	function resolveCurrentPluginConfig(config) {
		return resolvePluginConfigObject(config, providerId) ?? (config ? void 0 : startupPluginConfig);
	}
	api.registerProvider({
		id: providerId,
		label: "Amazon Bedrock Mantle (OpenAI-compatible)",
		docsPath: "/providers/bedrock-mantle",
		auth: [],
		catalog: {
			order: "simple",
			run: async (ctx) => {
				const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);
				const implicit = await resolveImplicitMantleProvider({
					env: ctx.env,
					pluginConfig: currentPluginConfig
				});
				if (!implicit) return null;
				return { provider: mergeImplicitMantleProvider({
					existing: ctx.config.models?.providers?.[providerId],
					implicit
				}) };
			}
		},
		resolveConfigApiKey: ({ env }) => resolveMantleBearerToken(env) ? "env:AWS_BEARER_TOKEN_BEDROCK" : void 0,
		prepareRuntimeAuth: async ({ apiKey, env }) => await resolveMantleRuntimeBearerToken({
			apiKey,
			env
		}),
		createStreamFn: ({ model }) => model.api === "anthropic-messages" ? createMantleAnthropicStreamFn() : void 0,
		matchesContextOverflowError: ({ errorMessage }) => /context_length_exceeded|max.*tokens.*exceeded/i.test(errorMessage),
		classifyFailoverReason: ({ errorMessage }) => {
			if (/rate_limit|too many requests|429/i.test(errorMessage)) return "rate_limit";
			if (/overloaded|503|service.*unavailable/i.test(errorMessage)) return "overloaded";
		}
	});
}
//#endregion
export { registerBedrockMantlePlugin as t };
