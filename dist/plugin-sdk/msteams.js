import "./github-copilot-token-2dC_MzAJ.js";
import { at as extensionForMime, bn as normalizeAccountId, it as detectMime, ot as getFileExtension, rn as normalizeStringEntries, yn as DEFAULT_ACCOUNT_ID } from "./query-expansion-BisNaWAT.js";
import "./paths-DinMprTu.js";
import { C as sleep } from "./logger-D_11x3rk.js";
import { C as createTypingCallbacks, Ci as DEFAULT_GROUP_HISTORY_LIMIT, D as resolveDmGroupAccessWithLists, Di as recordPendingHistoryEntryIfEnabled, Ei as clearHistoryEntriesIfEnabled, Fi as normalizeChannelSlug, Ii as resolveChannelEntryMatchWithFallback, It as readJsonFileWithFallback, Kr as fetchWithSsrFGuard, L as withReplyDispatcher, Li as resolveNestedAllowlistDecision, Lt as writeJsonFileAtomically, Mi as formatAllowlistMatchMeta, Ni as resolveAllowlistMatchSimple, Nn as loadWebMedia, O as resolveEffectiveAllowFromLists, Pi as buildChannelKeyCandidates, Pr as extractOriginalFilename, Qt as resolveDefaultGroupPolicy, R as dispatchReplyFromConfig, Rt as withFileLock, S as isDangerousNameMatchingEnabled, Si as isSilentReplyText, T as readStoreAllowFromForDmPolicy, Ti as buildPendingHistoryContextFromMap, Xt as resolveSenderScopedGroupPolicy, Yt as evaluateSenderGroupAccessForPolicy, Zt as resolveAllowlistProviderRuntimeGroupPolicy, _ as DEFAULT_WEBHOOK_MAX_BODY_BYTES, _i as resolveControlCommandGate, bi as SILENT_REPLY_TOKEN, f as formatDocsLink, fi as buildMediaPayload, gi as logTypingFailure, hi as logInboundDrop, mi as resolveMentionGating, na as normalizeResolvedSecretInputString, ni as MSTeamsConfigSchema, oa as resolveToolsBySender, pi as resolveChannelMediaMaxBytes, qr as isPrivateIpAddress, ra as normalizeSecretInputString, ta as hasConfiguredSecretInput, v as resolveInboundSessionEnvelopeContext, vi as mergeAllowlist, w as createReplyPrefixOptions, yi as summarizeMapping } from "./model-auth-BhLuBplx.js";
import "./fetch-Bb1Xmoh0.js";
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
function addWildcardAllowFrom(allowFrom) {
	const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
	if (!next.includes("*")) next.push("*");
	return next;
}
function mergeAllowFromEntries(current, additions) {
	const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
	return [...new Set(merged)];
}
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function patchTopLevelChannelConfig(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channel]: {
				...channelConfig,
				...params.enabled ? { enabled: true } : {},
				...params.patch
			}
		}
	};
}
function setTopLevelChannelAllowFrom(params) {
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		enabled: params.enabled,
		patch: { allowFrom: params.allowFrom }
	});
}
function setTopLevelChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	const existingAllowFrom = params.getAllowFrom?.(params.cfg) ?? channelConfig.allowFrom ?? void 0;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function setTopLevelChannelGroupPolicy(params) {
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		enabled: params.enabled,
		patch: { groupPolicy: params.groupPolicy }
	});
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
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
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
//#region src/plugin-sdk/channel-lifecycle.ts
/**
* Keep a channel/provider task pending until the HTTP server closes.
*
* When an abort signal is provided, `onAbort` is invoked once and should
* trigger server shutdown. The returned promise resolves only after `close`.
*/
async function keepHttpServerTaskAlive(params) {
	const { server, abortSignal, onAbort } = params;
	let abortTask = Promise.resolve();
	let abortTriggered = false;
	const triggerAbort = () => {
		if (abortTriggered) return;
		abortTriggered = true;
		abortTask = Promise.resolve(onAbort?.()).then(() => void 0);
	};
	const onAbortSignal = () => {
		triggerAbort();
	};
	if (abortSignal) if (abortSignal.aborted) triggerAbort();
	else abortSignal.addEventListener("abort", onAbortSignal, { once: true });
	await new Promise((resolve) => {
		server.once("close", () => resolve());
	});
	if (abortSignal) abortSignal.removeEventListener("abort", onAbortSignal);
	await abortTask;
}
//#endregion
//#region src/plugin-sdk/inbound-reply-dispatch.ts
async function dispatchReplyFromConfigWithSettledDispatcher(params) {
	return await withReplyDispatcher({
		dispatcher: params.dispatcher,
		onSettled: params.onSettled,
		run: () => dispatchReplyFromConfig({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions
		})
	});
}
//#endregion
//#region src/plugin-sdk/outbound-media.ts
async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
	return await loadWebMedia(mediaUrl, {
		maxBytes: options.maxBytes,
		localRoots: options.mediaLocalRoots
	});
}
//#endregion
//#region src/plugin-sdk/pairing-access.ts
function createScopedPairingAccess(params) {
	const resolvedAccountId = normalizeAccountId(params.accountId);
	return {
		accountId: resolvedAccountId,
		readAllowFromStore: () => params.core.channel.pairing.readAllowFromStore({
			channel: params.channel,
			accountId: resolvedAccountId
		}),
		readStoreForDmPolicy: (provider, accountId) => params.core.channel.pairing.readAllowFromStore({
			channel: provider,
			accountId: normalizeAccountId(accountId)
		}),
		upsertPairingRequest: (input) => params.core.channel.pairing.upsertPairingRequest({
			channel: params.channel,
			accountId: resolvedAccountId,
			...input
		})
	};
}
//#endregion
//#region src/plugin-sdk/ssrf-policy.ts
function normalizeHostnameSuffix(value) {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "";
	if (trimmed === "*" || trimmed === "*.") return "*";
	return trimmed.replace(/^\*\.?/, "").replace(/^\.+/, "").replace(/\.+$/, "");
}
function isHostnameAllowedBySuffixAllowlist(hostname, allowlist) {
	if (allowlist.includes("*")) return true;
	const normalized = hostname.toLowerCase();
	return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}
function normalizeHostnameSuffixAllowlist(input, defaults) {
	const source = input && input.length > 0 ? input : defaults;
	if (!source || source.length === 0) return [];
	const normalized = source.map(normalizeHostnameSuffix).filter(Boolean);
	if (normalized.includes("*")) return ["*"];
	return Array.from(new Set(normalized));
}
function isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") return false;
		return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
	} catch {
		return false;
	}
}
/**
* Converts suffix-style host allowlists (for example "example.com") into SSRF
* hostname allowlist patterns used by the shared fetch guard.
*
* Suffix semantics:
* - "example.com" allows "example.com" and "*.example.com"
* - "*" disables hostname allowlist restrictions
*/
function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts) {
	const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
	if (normalizedAllowHosts.length === 0) return;
	const patterns = /* @__PURE__ */ new Set();
	for (const normalized of normalizedAllowHosts) {
		if (normalized === "*") return;
		patterns.add(normalized);
		patterns.add(`*.${normalized}`);
	}
	if (patterns.size === 0) return;
	return { hostnameAllowlist: Array.from(patterns) };
}
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function createDefaultChannelRuntimeState(accountId, extra) {
	return {
		accountId,
		running: false,
		lastStartAt: null,
		lastStopAt: null,
		lastError: null,
		...extra ?? {}
	};
}
function buildBaseChannelStatusSummary(snapshot) {
	return {
		configured: snapshot.configured ?? false,
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
function buildProbeChannelStatusSummary(snapshot, extra) {
	return {
		...buildBaseChannelStatusSummary(snapshot),
		...extra ?? {},
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
}
function buildRuntimeAccountStatusSnapshot(params) {
	const { runtime, probe } = params;
	return {
		running: runtime?.running ?? false,
		lastStartAt: runtime?.lastStartAt ?? null,
		lastStopAt: runtime?.lastStopAt ?? null,
		lastError: runtime?.lastError ?? null,
		probe
	};
}
//#endregion
export { DEFAULT_ACCOUNT_ID, DEFAULT_GROUP_HISTORY_LIMIT, DEFAULT_WEBHOOK_MAX_BODY_BYTES, MSTeamsConfigSchema, PAIRING_APPROVED_MESSAGE, SILENT_REPLY_TOKEN, addWildcardAllowFrom, buildBaseChannelStatusSummary, buildChannelConfigSchema, buildChannelKeyCandidates, buildHostnameAllowlistPolicyFromSuffixAllowlist, buildMediaPayload, buildPendingHistoryContextFromMap, buildProbeChannelStatusSummary, buildRuntimeAccountStatusSnapshot, clearHistoryEntriesIfEnabled, createDefaultChannelRuntimeState, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, detectMime, dispatchReplyFromConfigWithSettledDispatcher, emptyPluginConfigSchema, evaluateSenderGroupAccessForPolicy, extensionForMime, extractOriginalFilename, fetchWithSsrFGuard, formatAllowlistMatchMeta, formatDocsLink, getFileExtension, hasConfiguredSecretInput, isDangerousNameMatchingEnabled, isHttpsUrlAllowedByHostnameSuffixAllowlist, isPrivateIpAddress, isSilentReplyText, keepHttpServerTaskAlive, loadOutboundMediaFromUrl, loadWebMedia, logInboundDrop, logTypingFailure, mergeAllowFromEntries, mergeAllowlist, normalizeChannelSlug, normalizeHostnameSuffixAllowlist, normalizeResolvedSecretInputString, normalizeSecretInputString, normalizeStringEntries, promptChannelAccessConfig, readJsonFileWithFallback, readStoreAllowFromForDmPolicy, recordPendingHistoryEntryIfEnabled, resolveAllowlistMatchSimple, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelEntryMatchWithFallback, resolveChannelMediaMaxBytes, resolveControlCommandGate, resolveDefaultGroupPolicy, resolveDmGroupAccessWithLists, resolveEffectiveAllowFromLists, resolveInboundSessionEnvelopeContext, resolveMentionGating, resolveNestedAllowlistDecision, resolveSenderScopedGroupPolicy, resolveToolsBySender, setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom, setTopLevelChannelGroupPolicy, sleep, splitOnboardingEntries, summarizeMapping, withFileLock, writeJsonFileAtomically };
