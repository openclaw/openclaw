import { c as normalizeOptionalString } from "../../string-coerce-LndEvhRk.js";
import { n as ensureAuthProfileStore } from "../../store-a4exFSck.js";
import { t as normalizeOptionalSecretInput } from "../../normalize-secret-input-CrCOUFln.js";
import { n as listProfilesForProvider } from "../../profile-list-1dJMPDMe.js";
import { a as upsertAuthProfile } from "../../profiles-Bj_dclxz.js";
import { i as normalizeApiKeyInput, n as ensureApiKeyFromOptionEnvOrPrompt, s as validateApiKeyInput } from "../../provider-auth-input-BB3v7mkT.js";
import { n as buildApiKeyCredential, t as applyAuthProfileConfig } from "../../provider-auth-helpers-Hp3hWZu2.js";
import "../../provider-auth-D5QGE8z6.js";
import "../../string-coerce-runtime-Ce59bOpy.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { n as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "../../models-Cu5ZjJIJ.js";
import { t as buildCloudflareAiGatewayCatalogProvider } from "../../catalog-provider-CMLtkcKc.js";
import { r as buildCloudflareAiGatewayConfigPatch, t as applyCloudflareAiGatewayConfig } from "../../onboard-CKkqO4a8.js";
import { r as wrapCloudflareAiGatewayProviderStream } from "../../stream-wrappers-DpuUHMio.js";
//#region extensions/cloudflare-ai-gateway/index.ts
const PROVIDER_ID = "cloudflare-ai-gateway";
const PROVIDER_ENV_VAR = "CLOUDFLARE_AI_GATEWAY_API_KEY";
const PROFILE_ID = "cloudflare-ai-gateway:default";
function readRequiredTextInput(value) {
	return typeof value === "string" ? value.trim() : "";
}
async function resolveCloudflareGatewayMetadataInteractive(ctx) {
	let accountId = normalizeOptionalString(ctx.accountId) ?? "";
	let gatewayId = normalizeOptionalString(ctx.gatewayId) ?? "";
	if (!accountId) accountId = readRequiredTextInput(await ctx.prompter.text({
		message: "Enter Cloudflare Account ID",
		validate: (val) => readRequiredTextInput(val) ? void 0 : "Account ID is required"
	}));
	if (!gatewayId) gatewayId = readRequiredTextInput(await ctx.prompter.text({
		message: "Enter Cloudflare AI Gateway ID",
		validate: (val) => readRequiredTextInput(val) ? void 0 : "Gateway ID is required"
	}));
	return {
		accountId,
		gatewayId
	};
}
var cloudflare_ai_gateway_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "Cloudflare AI Gateway Provider",
	description: "Bundled Cloudflare AI Gateway provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Cloudflare AI Gateway",
			docsPath: "/providers/cloudflare-ai-gateway",
			envVars: ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
			auth: [{
				id: "api-key",
				label: "Cloudflare AI Gateway",
				hint: "Account ID + Gateway ID + API key",
				kind: "api_key",
				wizard: {
					choiceId: "cloudflare-ai-gateway-api-key",
					choiceLabel: "Cloudflare AI Gateway",
					choiceHint: "Account ID + Gateway ID + API key",
					groupId: "cloudflare-ai-gateway",
					groupLabel: "Cloudflare AI Gateway",
					groupHint: "Account ID + Gateway ID + API key"
				},
				run: async (ctx) => {
					const metadata = await resolveCloudflareGatewayMetadataInteractive({
						accountId: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayAccountId),
						gatewayId: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayGatewayId),
						prompter: ctx.prompter
					});
					let capturedSecretInput = "";
					let capturedCredential = false;
					let capturedMode;
					await ensureApiKeyFromOptionEnvOrPrompt({
						token: normalizeOptionalSecretInput(ctx.opts?.cloudflareAiGatewayApiKey),
						tokenProvider: "cloudflare-ai-gateway",
						secretInputMode: ctx.allowSecretRefPrompt === false ? ctx.secretInputMode ?? "plaintext" : ctx.secretInputMode,
						config: ctx.config,
						expectedProviders: [PROVIDER_ID],
						provider: PROVIDER_ID,
						envLabel: PROVIDER_ENV_VAR,
						promptMessage: "Enter Cloudflare AI Gateway API key",
						normalize: normalizeApiKeyInput,
						validate: validateApiKeyInput,
						prompter: ctx.prompter,
						setCredential: async (apiKey, mode) => {
							capturedSecretInput = apiKey;
							capturedCredential = true;
							capturedMode = mode;
						}
					});
					if (!capturedCredential) throw new Error("Missing Cloudflare AI Gateway API key.");
					return {
						profiles: [{
							profileId: PROFILE_ID,
							credential: buildApiKeyCredential(PROVIDER_ID, capturedSecretInput ?? "", {
								accountId: metadata.accountId,
								gatewayId: metadata.gatewayId
							}, capturedMode ? { secretInputMode: capturedMode } : void 0)
						}],
						configPatch: buildCloudflareAiGatewayConfigPatch(metadata),
						defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF
					};
				},
				runNonInteractive: async (ctx) => {
					const authStore = ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false });
					const storedMetadata = authStore.profiles[PROFILE_ID]?.type === "api_key" ? {
						accountId: normalizeOptionalString(authStore.profiles[PROFILE_ID]?.metadata?.accountId),
						gatewayId: normalizeOptionalString(authStore.profiles[PROFILE_ID]?.metadata?.gatewayId)
					} : {};
					const accountId = normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayAccountId) ?? storedMetadata.accountId;
					const gatewayId = normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayGatewayId) ?? storedMetadata.gatewayId;
					if (!accountId || !gatewayId) {
						ctx.runtime.error("Cloudflare AI Gateway setup requires --cloudflare-ai-gateway-account-id and --cloudflare-ai-gateway-gateway-id.");
						ctx.runtime.exit(1);
						return null;
					}
					const resolved = await ctx.resolveApiKey({
						provider: PROVIDER_ID,
						flagValue: normalizeOptionalSecretInput(ctx.opts.cloudflareAiGatewayApiKey),
						flagName: "--cloudflare-ai-gateway-api-key",
						envVar: PROVIDER_ENV_VAR
					});
					if (!resolved) return null;
					if (resolved.source !== "profile") {
						const credential = ctx.toApiKeyCredential({
							provider: PROVIDER_ID,
							resolved,
							metadata: {
								accountId,
								gatewayId
							}
						});
						if (!credential) return null;
						upsertAuthProfile({
							profileId: PROFILE_ID,
							credential,
							agentDir: ctx.agentDir
						});
					}
					return applyCloudflareAiGatewayConfig(applyAuthProfileConfig(ctx.config, {
						profileId: PROFILE_ID,
						provider: PROVIDER_ID,
						mode: "api_key"
					}), {
						accountId,
						gatewayId
					});
				}
			}],
			catalog: {
				order: "late",
				run: async (ctx) => {
					const authStore = ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false });
					const envManagedApiKey = normalizeOptionalString(ctx.env[PROVIDER_ENV_VAR]) ? PROVIDER_ENV_VAR : void 0;
					for (const profileId of listProfilesForProvider(authStore, PROVIDER_ID)) {
						const provider = buildCloudflareAiGatewayCatalogProvider({
							credential: authStore.profiles[profileId],
							envApiKey: envManagedApiKey
						});
						if (!provider) continue;
						return { provider };
					}
					return null;
				}
			},
			classifyFailoverReason: ({ errorMessage }) => /\bworkers?_ai\b.*\b(?:rate|limit|quota)\b/i.test(errorMessage) ? "rate_limit" : void 0,
			wrapStreamFn: wrapCloudflareAiGatewayProviderStream
		});
	}
});
//#endregion
export { cloudflare_ai_gateway_default as default };
