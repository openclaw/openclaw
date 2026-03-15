import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import { r as coerceSecretRef } from "../../types.secrets-apkw3WZr.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import "../../paths-OqPpu-UR.js";
import { Kl as normalizeApiKeyInput, Vl as ensureApiKeyFromOptionEnvOrPrompt, nf as resolveNonEnvSecretRefApiKeyMarker, ql as validateApiKeyInput } from "../../auth-profiles-CuJtivJK.js";
import { a as ensureAuthProfileStore, i as upsertAuthProfile, n as listProfilesForProvider } from "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import { t as normalizeOptionalSecretInput } from "../../normalize-secret-input-CZ08wtw1.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { D as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, E as buildApiKeyCredential, O as buildCloudflareAiGatewayModelDefinition, k as resolveCloudflareAiGatewayBaseUrl, v as applyCloudflareAiGatewayConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import { t as applyAuthProfileConfig } from "../../auth-profile-config-Dyrd8Od7.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
//#region extensions/cloudflare-ai-gateway/index.ts
const PROVIDER_ID = "cloudflare-ai-gateway";
const PROVIDER_ENV_VAR = "CLOUDFLARE_AI_GATEWAY_API_KEY";
const PROFILE_ID = "cloudflare-ai-gateway:default";
function resolveApiKeyFromCredential(cred) {
	if (!cred || cred.type !== "api_key") return;
	const keyRef = coerceSecretRef(cred.keyRef);
	if (keyRef && keyRef.id.trim()) return keyRef.source === "env" ? keyRef.id.trim() : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
	return cred.key?.trim() || void 0;
}
function resolveMetadataFromCredential(cred) {
	if (!cred || cred.type !== "api_key") return {};
	return {
		accountId: cred?.metadata?.accountId?.trim() || void 0,
		gatewayId: cred?.metadata?.gatewayId?.trim() || void 0
	};
}
function buildCloudflareConfigPatch(params) {
	const baseUrl = resolveCloudflareAiGatewayBaseUrl(params);
	return {
		models: { providers: { [PROVIDER_ID]: {
			baseUrl,
			api: "anthropic-messages",
			models: [buildCloudflareAiGatewayModelDefinition()]
		} } },
		agents: { defaults: { models: { [CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]: { alias: "Cloudflare AI Gateway" } } } }
	};
}
async function resolveCloudflareGatewayMetadataInteractive(ctx) {
	let accountId = ctx.accountId?.trim() ?? "";
	let gatewayId = ctx.gatewayId?.trim() ?? "";
	if (!accountId) {
		const value = await ctx.prompter.text({
			message: "Enter Cloudflare Account ID",
			validate: (val) => String(val ?? "").trim() ? void 0 : "Account ID is required"
		});
		accountId = String(value ?? "").trim();
	}
	if (!gatewayId) {
		const value = await ctx.prompter.text({
			message: "Enter Cloudflare AI Gateway ID",
			validate: (val) => String(val ?? "").trim() ? void 0 : "Gateway ID is required"
		});
		gatewayId = String(value ?? "").trim();
	}
	return {
		accountId,
		gatewayId
	};
}
const cloudflareAiGatewayPlugin = {
	id: PROVIDER_ID,
	name: "Cloudflare AI Gateway Provider",
	description: "Bundled Cloudflare AI Gateway provider plugin",
	configSchema: emptyPluginConfigSchema(),
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
					let capturedSecretInput;
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
						configPatch: buildCloudflareConfigPatch(metadata),
						defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF
					};
				},
				runNonInteractive: async (ctx) => {
					const storedMetadata = resolveMetadataFromCredential(ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false }).profiles[PROFILE_ID]);
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
					const envManagedApiKey = ctx.env[PROVIDER_ENV_VAR]?.trim() ? PROVIDER_ENV_VAR : void 0;
					for (const profileId of listProfilesForProvider(authStore, PROVIDER_ID)) {
						const cred = authStore.profiles[profileId];
						if (!cred || cred.type !== "api_key") continue;
						const apiKey = envManagedApiKey ?? resolveApiKeyFromCredential(cred);
						if (!apiKey) continue;
						const accountId = cred.metadata?.accountId?.trim();
						const gatewayId = cred.metadata?.gatewayId?.trim();
						if (!accountId || !gatewayId) continue;
						const baseUrl = resolveCloudflareAiGatewayBaseUrl({
							accountId,
							gatewayId
						});
						if (!baseUrl) continue;
						return { provider: {
							baseUrl,
							api: "anthropic-messages",
							apiKey,
							models: [buildCloudflareAiGatewayModelDefinition()]
						} };
					}
					return null;
				}
			}
		});
	}
};
//#endregion
export { cloudflareAiGatewayPlugin as default };
