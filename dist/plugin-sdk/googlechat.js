import "./github-copilot-token-DsS-4gYS.js";
import { on as DEFAULT_ACCOUNT_ID, sn as normalizeAccountId } from "./query-expansion-Ct5-hJ3e.js";
import "./utils-DbcH71uP.js";
import "./paths-Dmn791zP.js";
import { $t as resolveAllowlistProviderRuntimeGroupPolicy, A as resolveDmGroupAccessWithLists, Ai as formatPairingApproveHint, Bi as resolveMentionGatingWithBypass, C as issuePairingChallenge, Ft as pruneMapToMaxSize, Gi as readReactionParams, Hi as createActionGate, Ii as isSecretRef, Ki as readStringParam, Li as deleteAccountFromConfigSection, M as extractToolSend, Mi as resolveGoogleChatGroupRequireMention, Ni as createAccountListHelpers, Qt as GROUP_POLICY_BLOCKED_LABEL, Ri as setAccountEnabledInConfigSection, T as createReplyPrefixOptions, Ui as jsonResult, Wi as readNumberParam, Xt as evaluateGroupRouteAccessForPolicy, Zt as resolveSenderScopedGroupPolicy, _ as readJsonBodyWithLimit, b as registerPluginHttpRoute, bi as getChatChannelMeta, en as resolveDefaultGroupPolicy, f as formatDocsLink, ki as resolveChannelMediaMaxBytes, li as fetchWithSsrFGuard, ln as missingTargetError, nn as warnMissingProviderGroupPolicyFallbackOnce, v as requestBodyErrorToText, vi as GoogleChatConfigSchema, w as isDangerousNameMatchingEnabled } from "./model-auth-DeIZH5u7.js";
import "./fetch-BIseQ86E.js";
import { z } from "zod";
//#region src/channels/plugins/directory-config-helpers.ts
function resolveDirectoryQuery(query) {
	return query?.trim().toLowerCase() || "";
}
function resolveDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : void 0;
}
function applyDirectoryQueryAndLimit(ids, params) {
	const q = resolveDirectoryQuery(params.query);
	const limit = resolveDirectoryLimit(params.limit);
	const filtered = ids.filter((id) => q ? id.toLowerCase().includes(q) : true);
	return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}
function toDirectoryEntries(kind, ids) {
	return ids.map((id) => ({
		kind,
		id
	}));
}
function collectDirectoryIdsFromEntries(params) {
	return (params.entries ?? []).map((entry) => String(entry).trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function collectDirectoryIdsFromMapKeys(params) {
	return Object.keys(params.groups ?? {}).map((entry) => entry.trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function dedupeDirectoryIds(ids) {
	return Array.from(new Set(ids));
}
function listDirectoryUserEntriesFromAllowFrom(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryGroupEntriesFromMapKeys(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeId
	})), params));
}
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function buildBaseAccountStatusSnapshot(params) {
	const { account, runtime, probe } = params;
	return {
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: account.configured,
		...buildRuntimeAccountStatusSnapshot({
			runtime,
			probe
		}),
		lastInboundAt: runtime?.lastInboundAt ?? null,
		lastOutboundAt: runtime?.lastOutboundAt ?? null
	};
}
function buildComputedAccountStatusSnapshot(params) {
	const { accountId, name, enabled, configured, runtime, probe } = params;
	return buildBaseAccountStatusSnapshot({
		account: {
			accountId,
			name,
			enabled,
			configured
		},
		runtime,
		probe
	});
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
//#region src/plugin-sdk/channel-lifecycle.ts
function createAccountStatusSink(params) {
	return (patch) => {
		params.setStatus({
			accountId: params.accountId,
			...patch
		});
	};
}
/**
* Return a promise that resolves when the signal is aborted.
*
* If no signal is provided, the promise stays pending forever. When provided,
* `onAbort` runs once before the promise resolves.
*/
function waitUntilAbort(signal, onAbort) {
	return new Promise((resolve, reject) => {
		const complete = () => {
			Promise.resolve(onAbort?.()).then(() => resolve(), reject);
		};
		if (!signal) return;
		if (signal.aborted) {
			complete();
			return;
		}
		signal.addEventListener("abort", complete, { once: true });
	});
}
/**
* Keep a passive account task alive until abort, then run optional cleanup.
*/
async function runPassiveAccountLifecycle(params) {
	const handle = await params.start();
	try {
		await waitUntilAbort(params.abortSignal);
	} finally {
		await params.stop?.(handle);
		await params.onStop?.();
	}
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
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || "default";
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === "default" ? "default (primary)" : id
		})), {
			value: "__new__",
			label: "Add a new account"
		}],
		initialValue: initial
	});
	if (choice !== "__new__") return normalizeAccountId(choice);
	const entered = await params.prompter.text({
		message: `New ${params.label} account id`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const normalized = normalizeAccountId(String(entered));
	if (String(entered).trim() !== normalized) await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
	return normalized;
}
//#endregion
//#region src/channels/plugins/setup-helpers.ts
function channelHasAccounts(cfg, channelKey) {
	const base = cfg.channels?.[channelKey];
	return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
	if (params.alwaysUseAccounts) return true;
	if (params.accountId !== "default") return true;
	return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return params.cfg;
	const accountId = normalizeAccountId(params.accountId);
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!shouldStoreNameInAccounts({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId,
		alwaysUseAccounts: params.alwaysUseAccounts
	}) && accountId === "default") {
		const safeBase = base ?? {};
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.channelKey]: {
					...safeBase,
					name: trimmed
				}
			}
		};
	}
	const baseAccounts = base?.accounts ?? {};
	const existingAccount = baseAccounts[accountId] ?? {};
	const baseWithoutName = accountId === "default" ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...baseWithoutName,
				accounts: {
					...baseAccounts,
					[accountId]: {
						...existingAccount,
						name: trimmed
					}
				}
			}
		}
	};
}
function migrateBaseNameToDefaultAccount(params) {
	if (params.alwaysUseAccounts) return params.cfg;
	const base = params.cfg.channels?.[params.channelKey];
	const baseName = base?.name?.trim();
	if (!baseName) return params.cfg;
	const accounts = { ...base?.accounts };
	const defaultAccount = accounts["default"] ?? {};
	if (!defaultAccount.name) accounts[DEFAULT_ACCOUNT_ID] = {
		...defaultAccount,
		name: baseName
	};
	const { name: _ignored, ...rest } = base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...rest,
				accounts
			}
		}
	};
}
function applySetupAccountConfigPatch(params) {
	return patchScopedAccountConfig({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId: params.accountId,
		patch: params.patch
	});
}
function patchScopedAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof channelConfig === "object" && channelConfig ? channelConfig : void 0;
	const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
	const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
	const patch = params.patch;
	const accountPatch = params.accountPatch ?? patch;
	if (accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = base?.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureAccountEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...accountPatch
					}
				}
			}
		}
	};
}
//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
const promptAccountId = async (params) => {
	return await promptAccountId$1(params);
};
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
async function resolveAccountIdForConfigure(params) {
	const override = params.accountOverride?.trim();
	let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
	if (params.shouldPromptAccountIds && !override) accountId = await promptAccountId({
		cfg: params.cfg,
		prompter: params.prompter,
		label: params.label,
		currentId: accountId,
		listAccountIds: params.listAccountIds,
		defaultAccountId: params.defaultAccountId
	});
	return accountId;
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
//#region src/plugin-sdk/inbound-envelope.ts
function createInboundEnvelopeBuilder(params) {
	const storePath = params.resolveStorePath(params.sessionStore, { agentId: params.route.agentId });
	const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
	return (input) => {
		const previousTimestamp = params.readSessionUpdatedAt({
			storePath,
			sessionKey: params.route.sessionKey
		});
		return {
			storePath,
			body: params.formatAgentEnvelope({
				channel: input.channel,
				from: input.from,
				timestamp: input.timestamp,
				previousTimestamp,
				envelope: envelopeOptions,
				body: input.body
			})
		};
	};
}
function resolveInboundRouteEnvelopeBuilder(params) {
	const route = params.resolveAgentRoute({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer
	});
	return {
		route,
		buildEnvelope: createInboundEnvelopeBuilder({
			cfg: params.cfg,
			route,
			sessionStore: params.sessionStore,
			resolveStorePath: params.resolveStorePath,
			readSessionUpdatedAt: params.readSessionUpdatedAt,
			resolveEnvelopeFormatOptions: params.resolveEnvelopeFormatOptions,
			formatAgentEnvelope: params.formatAgentEnvelope
		})
	};
}
function resolveInboundRouteEnvelopeBuilderWithRuntime(params) {
	return resolveInboundRouteEnvelopeBuilder({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer,
		resolveAgentRoute: (routeParams) => params.runtime.routing.resolveAgentRoute(routeParams),
		sessionStore: params.sessionStore,
		resolveStorePath: params.runtime.session.resolveStorePath,
		readSessionUpdatedAt: params.runtime.session.readSessionUpdatedAt,
		resolveEnvelopeFormatOptions: params.runtime.reply.resolveEnvelopeFormatOptions,
		formatAgentEnvelope: params.runtime.reply.formatAgentEnvelope
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
//#region src/plugin-sdk/webhook-path.ts
function normalizeWebhookPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "/";
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
	return withSlash;
}
function resolveWebhookPath(params) {
	const trimmedPath = params.webhookPath?.trim();
	if (trimmedPath) return normalizeWebhookPath(trimmedPath);
	if (params.webhookUrl?.trim()) try {
		return normalizeWebhookPath(new URL(params.webhookUrl).pathname || "/");
	} catch {
		return null;
	}
	return params.defaultPath ?? null;
}
//#endregion
//#region src/plugin-sdk/webhook-request-guards.ts
const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
	preAuth: {
		maxBytes: 64 * 1024,
		timeoutMs: 5e3
	},
	postAuth: {
		maxBytes: 1024 * 1024,
		timeoutMs: 3e4
	}
});
const WEBHOOK_IN_FLIGHT_DEFAULTS = Object.freeze({
	maxInFlightPerKey: 8,
	maxTrackedKeys: 4096
});
function resolveWebhookBodyReadLimits(params) {
	const defaults = params.profile === "pre-auth" ? WEBHOOK_BODY_READ_DEFAULTS.preAuth : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
	return {
		maxBytes: typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0 ? Math.floor(params.maxBytes) : defaults.maxBytes,
		timeoutMs: typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.floor(params.timeoutMs) : defaults.timeoutMs
	};
}
function respondWebhookBodyReadError(params) {
	const { res, code, invalidMessage } = params;
	if (code === "PAYLOAD_TOO_LARGE") {
		res.statusCode = 413;
		res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
		return { ok: false };
	}
	if (code === "REQUEST_BODY_TIMEOUT") {
		res.statusCode = 408;
		res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
		return { ok: false };
	}
	if (code === "CONNECTION_CLOSED") {
		res.statusCode = 400;
		res.end(requestBodyErrorToText("CONNECTION_CLOSED"));
		return { ok: false };
	}
	res.statusCode = 400;
	res.end(invalidMessage ?? "Bad Request");
	return { ok: false };
}
function createWebhookInFlightLimiter(options) {
	const maxInFlightPerKey = Math.max(1, Math.floor(options?.maxInFlightPerKey ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey));
	const maxTrackedKeys = Math.max(1, Math.floor(options?.maxTrackedKeys ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys));
	const active = /* @__PURE__ */ new Map();
	return {
		tryAcquire: (key) => {
			if (!key) return true;
			const current = active.get(key) ?? 0;
			if (current >= maxInFlightPerKey) return false;
			active.set(key, current + 1);
			pruneMapToMaxSize(active, maxTrackedKeys);
			return true;
		},
		release: (key) => {
			if (!key) return;
			const current = active.get(key);
			if (current === void 0) return;
			if (current <= 1) {
				active.delete(key);
				return;
			}
			active.set(key, current - 1);
		},
		size: () => active.size,
		clear: () => active.clear()
	};
}
function isJsonContentType(value) {
	const first = Array.isArray(value) ? value[0] : value;
	if (!first) return false;
	const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}
function applyBasicWebhookRequestGuards(params) {
	const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
	if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
		params.res.statusCode = 405;
		params.res.setHeader("Allow", allowMethods.join(", "));
		params.res.end("Method Not Allowed");
		return false;
	}
	if (params.rateLimiter && params.rateLimitKey && params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())) {
		params.res.statusCode = 429;
		params.res.end("Too Many Requests");
		return false;
	}
	if (params.requireJsonContentType && params.req.method === "POST" && !isJsonContentType(params.req.headers["content-type"])) {
		params.res.statusCode = 415;
		params.res.end("Unsupported Media Type");
		return false;
	}
	return true;
}
function beginWebhookRequestPipelineOrReject(params) {
	if (!applyBasicWebhookRequestGuards({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType
	})) return { ok: false };
	const inFlightKey = params.inFlightKey ?? "";
	const inFlightLimiter = params.inFlightLimiter;
	if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
		params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
		params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
		return { ok: false };
	}
	let released = false;
	return {
		ok: true,
		release: () => {
			if (released) return;
			released = true;
			if (inFlightLimiter && inFlightKey) inFlightLimiter.release(inFlightKey);
		}
	};
}
async function readJsonWebhookBodyOrReject(params) {
	const limits = resolveWebhookBodyReadLimits({
		maxBytes: params.maxBytes,
		timeoutMs: params.timeoutMs,
		profile: params.profile
	});
	const body = await readJsonBodyWithLimit(params.req, {
		maxBytes: limits.maxBytes,
		timeoutMs: limits.timeoutMs,
		emptyObjectOnEmpty: params.emptyObjectOnEmpty
	});
	if (body.ok) return {
		ok: true,
		value: body.value
	};
	return respondWebhookBodyReadError({
		res: params.res,
		code: body.code,
		invalidMessage: params.invalidJsonMessage
	});
}
//#endregion
//#region src/plugin-sdk/webhook-targets.ts
function registerWebhookTargetWithPluginRoute(params) {
	return registerWebhookTarget(params.targetsByPath, params.target, {
		onFirstPathTarget: ({ path }) => registerPluginHttpRoute({
			...params.route,
			path,
			replaceExisting: params.route.replaceExisting ?? true
		}),
		onLastPathTargetRemoved: params.onLastPathTargetRemoved
	});
}
const pathTeardownByTargetMap = /* @__PURE__ */ new WeakMap();
function getPathTeardownMap(targetsByPath) {
	const mapKey = targetsByPath;
	const existing = pathTeardownByTargetMap.get(mapKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	pathTeardownByTargetMap.set(mapKey, created);
	return created;
}
function registerWebhookTarget(targetsByPath, target, opts) {
	const key = normalizeWebhookPath(target.path);
	const normalizedTarget = {
		...target,
		path: key
	};
	const existing = targetsByPath.get(key) ?? [];
	if (existing.length === 0) {
		const onFirstPathResult = opts?.onFirstPathTarget?.({
			path: key,
			target: normalizedTarget
		});
		if (typeof onFirstPathResult === "function") getPathTeardownMap(targetsByPath).set(key, onFirstPathResult);
	}
	targetsByPath.set(key, [...existing, normalizedTarget]);
	let isActive = true;
	const unregister = () => {
		if (!isActive) return;
		isActive = false;
		const updated = (targetsByPath.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
		if (updated.length > 0) {
			targetsByPath.set(key, updated);
			return;
		}
		targetsByPath.delete(key);
		const teardown = getPathTeardownMap(targetsByPath).get(key);
		if (teardown) {
			getPathTeardownMap(targetsByPath).delete(key);
			teardown();
		}
		opts?.onLastPathTargetRemoved?.({ path: key });
	};
	return {
		target: normalizedTarget,
		unregister
	};
}
function resolveWebhookTargets(req, targetsByPath) {
	const path = normalizeWebhookPath(new URL(req.url ?? "/", "http://localhost").pathname);
	const targets = targetsByPath.get(path);
	if (!targets || targets.length === 0) return null;
	return {
		path,
		targets
	};
}
async function withResolvedWebhookRequestPipeline(params) {
	const resolved = resolveWebhookTargets(params.req, params.targetsByPath);
	if (!resolved) return false;
	const inFlightKey = typeof params.inFlightKey === "function" ? params.inFlightKey({
		req: params.req,
		path: resolved.path,
		targets: resolved.targets
	}) : params.inFlightKey ?? `${resolved.path}:${params.req.socket?.remoteAddress ?? "unknown"}`;
	const requestLifecycle = beginWebhookRequestPipelineOrReject({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType,
		inFlightLimiter: params.inFlightLimiter,
		inFlightKey,
		inFlightLimitStatusCode: params.inFlightLimitStatusCode,
		inFlightLimitMessage: params.inFlightLimitMessage
	});
	if (!requestLifecycle.ok) return true;
	try {
		await params.handle(resolved);
		return true;
	} finally {
		requestLifecycle.release();
	}
}
function updateMatchedWebhookTarget(matched, target) {
	if (matched) return {
		ok: false,
		result: { kind: "ambiguous" }
	};
	return {
		ok: true,
		matched: target
	};
}
function finalizeMatchedWebhookTarget(matched) {
	if (!matched) return { kind: "none" };
	return {
		kind: "single",
		target: matched
	};
}
async function resolveSingleWebhookTargetAsync(targets, isMatch) {
	let matched;
	for (const target of targets) {
		if (!await isMatch(target)) continue;
		const updated = updateMatchedWebhookTarget(matched, target);
		if (!updated.ok) return updated.result;
		matched = updated.matched;
	}
	return finalizeMatchedWebhookTarget(matched);
}
async function resolveWebhookTargetWithAuthOrReject(params) {
	return resolveWebhookTargetMatchOrReject(params, await resolveSingleWebhookTargetAsync(params.targets, async (target) => Boolean(await params.isMatch(target))));
}
function resolveWebhookTargetMatchOrReject(params, match) {
	if (match.kind === "single") return match.target;
	if (match.kind === "ambiguous") {
		params.res.statusCode = params.ambiguousStatusCode ?? 401;
		params.res.end(params.ambiguousMessage ?? "ambiguous webhook target");
		return null;
	}
	params.res.statusCode = params.unauthorizedStatusCode ?? 401;
	params.res.end(params.unauthorizedMessage ?? "unauthorized");
	return null;
}
//#endregion
export { DEFAULT_ACCOUNT_ID, GROUP_POLICY_BLOCKED_LABEL, GoogleChatConfigSchema, PAIRING_APPROVED_MESSAGE, addWildcardAllowFrom, applyAccountNameToChannelSection, applySetupAccountConfigPatch, beginWebhookRequestPipelineOrReject, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, createAccountListHelpers, createAccountStatusSink, createActionGate, createReplyPrefixOptions, createScopedPairingAccess, createWebhookInFlightLimiter, deleteAccountFromConfigSection, emptyPluginConfigSchema, evaluateGroupRouteAccessForPolicy, extractToolSend, fetchWithSsrFGuard, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, isDangerousNameMatchingEnabled, isSecretRef, issuePairingChallenge, jsonResult, listDirectoryGroupEntriesFromMapKeys, listDirectoryUserEntriesFromAllowFrom, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, missingTargetError, normalizeAccountId, promptAccountId, readJsonWebhookBodyOrReject, readNumberParam, readReactionParams, readStringParam, registerWebhookTargetWithPluginRoute, resolveAccountIdForConfigure, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDmGroupAccessWithLists, resolveGoogleChatGroupRequireMention, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveMentionGatingWithBypass, resolveSenderScopedGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrReject, resolveWebhookTargets, runPassiveAccountLifecycle, setAccountEnabledInConfigSection, setTopLevelChannelDmPolicyWithAllowFrom, splitOnboardingEntries, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };
