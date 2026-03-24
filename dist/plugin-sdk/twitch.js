import "./github-copilot-token-DsS-4gYS.js";
import { C as createReplyPrefixOptions, Ei as MarkdownConfigSchema, f as formatDocsLink } from "./model-auth-rx7s8oFQ.js";
import "./logger-CO0eGZ-2.js";
import "./paths-Dmn791zP.js";
import "./fetch-BIaKGiR8.js";
import { vn as DEFAULT_ACCOUNT_ID, yn as normalizeAccountId } from "./query-expansion-DwgI07O9.js";
import { z } from "zod";
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
z.array(AllowFromEntrySchema).optional();
function buildChannelConfigSchema(schema) {
	const schemaWithJson = schema;
	if (typeof schemaWithJson.toJSONSchema === "function") return { schema: schemaWithJson.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	}) };
	return { schema: {
		type: "object",
		additionalProperties: true
	} };
}
//#endregion
//#region src/secrets/provider-env-vars.ts
const PROVIDER_ENV_VARS = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GEMINI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	venice: ["VENICE_API_KEY"],
	zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
	qianfan: ["QIANFAN_API_KEY"],
	xai: ["XAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	kilocode: ["KILOCODE_API_KEY"],
	modelstudio: ["MODELSTUDIO_API_KEY"],
	volcengine: ["VOLCANO_ENGINE_API_KEY"],
	byteplus: ["BYTEPLUS_API_KEY"]
};
const EXTRA_PROVIDER_AUTH_ENV_VARS = [
	"VOYAGE_API_KEY",
	"GROQ_API_KEY",
	"DEEPGRAM_API_KEY",
	"CEREBRAS_API_KEY",
	"NVIDIA_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"CHUTES_OAUTH_TOKEN",
	"CHUTES_API_KEY",
	"QWEN_OAUTH_TOKEN",
	"QWEN_PORTAL_API_KEY",
	"MINIMAX_OAUTH_TOKEN",
	"OLLAMA_API_KEY",
	"VLLM_API_KEY"
];
const KNOWN_SECRET_ENV_VARS = [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
[...new Set([...KNOWN_SECRET_ENV_VARS, ...EXTRA_PROVIDER_AUTH_ENV_VARS])];
//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
//#endregion
//#region src/channels/plugins/onboarding/channel-access.ts
function parseAllowlistEntries(raw) {
	return splitOnboardingEntries(String(raw ?? ""));
}
function formatAllowlistEntries(entries) {
	return entries.map((entry) => entry.trim()).filter(Boolean).join(", ");
}
async function promptChannelAccessPolicy(params) {
	const options = [{
		value: "allowlist",
		label: "Allowlist (recommended)"
	}];
	if (params.allowOpen !== false) options.push({
		value: "open",
		label: "Open (allow all channels)"
	});
	if (params.allowDisabled !== false) options.push({
		value: "disabled",
		label: "Disabled (block all channels)"
	});
	const initialValue = params.currentPolicy ?? "allowlist";
	return await params.prompter.select({
		message: `${params.label} access`,
		options,
		initialValue
	});
}
async function promptChannelAllowlist(params) {
	const initialValue = params.currentEntries && params.currentEntries.length > 0 ? formatAllowlistEntries(params.currentEntries) : void 0;
	return parseAllowlistEntries(await params.prompter.text({
		message: `${params.label} allowlist (comma-separated)`,
		placeholder: params.placeholder,
		initialValue
	}));
}
async function promptChannelAccessConfig(params) {
	const hasEntries = (params.currentEntries ?? []).length > 0;
	const shouldPrompt = params.defaultPrompt ?? !hasEntries;
	if (!await params.prompter.confirm({
		message: params.updatePrompt ? `Update ${params.label} access?` : `Configure ${params.label} access?`,
		initialValue: shouldPrompt
	})) return null;
	const policy = await promptChannelAccessPolicy({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		allowOpen: params.allowOpen,
		allowDisabled: params.allowDisabled
	});
	if (policy !== "allowlist") return {
		policy,
		entries: []
	};
	return {
		policy,
		entries: await promptChannelAllowlist({
			prompter: params.prompter,
			label: params.label,
			currentEntries: params.currentEntries,
			placeholder: params.placeholder
		})
	};
}
//#endregion
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
//#endregion
export { DEFAULT_ACCOUNT_ID, MarkdownConfigSchema, buildChannelConfigSchema, createReplyPrefixOptions, emptyPluginConfigSchema, formatDocsLink, normalizeAccountId, promptChannelAccessConfig };
