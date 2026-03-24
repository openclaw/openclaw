import "./github-copilot-token-2dC_MzAJ.js";
import { bn as normalizeAccountId, fn as normalizeAgentId, yn as DEFAULT_ACCOUNT_ID } from "./query-expansion-DD_kv3mg.js";
import "./paths-DinMprTu.js";
import "./logger-D0gLTTm5.js";
import { $t as resolveOpenProviderRuntimeGroupPolicy, Di as isValidExecSecretRefId, E as createReplyPrefixContext, Ei as formatExecSecretRefIdValidationMessage, Ji as hasConfiguredSecretInput, Jr as resolveSecretRefString, Lt as readJsonFileWithFallback, Mt as pruneMapToMaxSize, Oi as isValidFileSecretRefId, Qt as resolveDefaultGroupPolicy, Rt as writeJsonFileAtomically, S as issuePairingChallenge, T as createTypingCallbacks, Ti as SECRET_PROVIDER_ALIAS_PATTERN, Xi as normalizeResolvedSecretInputString, Xr as withTempDownloadPath, Xt as evaluateSenderGroupAccessForPolicy, Yi as isValidEnvSecretRefId, Yr as encodeJsonPointerToken, Zi as normalizeSecretInputString, Zr as fetchWithSsrFGuard, Zt as resolveAllowlistProviderRuntimeGroupPolicy, _ as installRequestBodyLimitGuard, bi as recordPendingHistoryEntryIfEnabled, en as warnMissingProviderGroupPolicyFallbackOnce, f as formatDocsLink, gi as DEFAULT_GROUP_HISTORY_LIMIT, hi as logTypingFailure, jt as createDedupeCache, ki as resolveDefaultSecretProviderAlias, qi as ENV_SECRET_REF_ID_RE, v as readJsonBodyWithLimit, vi as buildPendingHistoryContextFromMap, yi as clearHistoryEntriesIfEnabled, zt as withFileLock } from "./model-auth-Dsn1-Xna.js";
import "./fetch-co3gTMls.js";
import { z } from "zod";
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
//#region src/commands/auth-choice.apply-helpers.ts
function formatErrorMessage(error) {
	if (error instanceof Error && typeof error.message === "string" && error.message.trim()) return error.message;
	return String(error);
}
function resolveDefaultProviderEnvVar(provider) {
	return PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
}
function resolveDefaultFilePointerId(provider) {
	return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}
async function promptSecretRefForOnboarding(params) {
	const defaultEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
	const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
	let sourceChoice = "env";
	while (true) {
		const source = await params.prompter.select({
			message: params.copy?.sourceMessage ?? "Where is this API key stored?",
			initialValue: sourceChoice,
			options: [{
				value: "env",
				label: "Environment variable",
				hint: "Reference a variable from your runtime environment"
			}, {
				value: "provider",
				label: "Configured secret provider",
				hint: "Use a configured file or exec secret provider"
			}]
		}) === "provider" ? "provider" : "env";
		sourceChoice = source;
		if (source === "env") {
			const envVarRaw = await params.prompter.text({
				message: params.copy?.envVarMessage ?? "Environment variable name",
				initialValue: defaultEnvVar || void 0,
				placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
				validate: (value) => {
					const candidate = value.trim();
					if (!isValidEnvSecretRefId(candidate)) return params.copy?.envVarFormatError ?? "Use an env var name like \"OPENAI_API_KEY\" (uppercase letters, numbers, underscores).";
					if (!process.env[candidate]?.trim()) return params.copy?.envVarMissingError?.(candidate) ?? `Environment variable "${candidate}" is missing or empty in this session.`;
				}
			});
			const envCandidate = String(envVarRaw ?? "").trim();
			const envVar = envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : defaultEnvVar;
			if (!envVar) throw new Error(`No valid environment variable name provided for provider "${params.provider}".`);
			const ref = {
				source: "env",
				provider: resolveDefaultSecretProviderAlias(params.config, "env", { preferFirstProviderForSource: true }),
				id: envVar
			};
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(params.copy?.envValidatedMessage?.(envVar) ?? `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		}
		const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(([, provider]) => provider?.source === "file" || provider?.source === "exec");
		if (externalProviders.length === 0) {
			await params.prompter.note(params.copy?.noProvidersMessage ?? "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.", "No providers configured");
			continue;
		}
		const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", { preferFirstProviderForSource: true });
		const selectedProvider = await params.prompter.select({
			message: "Select secret provider",
			initialValue: externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ?? externalProviders[0]?.[0],
			options: externalProviders.map(([providerName, provider]) => ({
				value: providerName,
				label: providerName,
				hint: provider?.source === "exec" ? "Exec provider" : "File provider"
			}))
		});
		const providerEntry = params.config.secrets?.providers?.[selectedProvider];
		if (!providerEntry || providerEntry.source !== "file" && providerEntry.source !== "exec") {
			await params.prompter.note(`Provider "${selectedProvider}" is not a file/exec provider.`, "Invalid provider");
			continue;
		}
		const idPrompt = providerEntry.source === "file" ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)" : "Secret id for the exec provider";
		const idDefault = providerEntry.source === "file" ? providerEntry.mode === "singleValue" ? "value" : defaultFilePointer : `${params.provider}/apiKey`;
		const idRaw = await params.prompter.text({
			message: idPrompt,
			initialValue: idDefault,
			placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
			validate: (value) => {
				const candidate = value.trim();
				if (!candidate) return "Secret id cannot be empty.";
				if (providerEntry.source === "file" && providerEntry.mode !== "singleValue" && !isValidFileSecretRefId(candidate)) return "Use an absolute JSON pointer like \"/providers/openai/apiKey\".";
				if (providerEntry.source === "file" && providerEntry.mode === "singleValue" && candidate !== "value") return "singleValue mode expects id \"value\".";
				if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) return formatExecSecretRefIdValidationMessage();
			}
		});
		const id = String(idRaw ?? "").trim() || idDefault;
		const ref = {
			source: providerEntry.source,
			provider: selectedProvider,
			id
		};
		try {
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ?? `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		} catch (error) {
			await params.prompter.note([
				`Could not validate provider reference ${selectedProvider}:${id}.`,
				formatErrorMessage(error),
				"Check your provider configuration and try again."
			].join("\n"), "Reference check failed");
		}
	}
}
async function resolveSecretInputModeForEnvSelection(params) {
	if (params.explicitMode) return params.explicitMode;
	if (typeof params.prompter.select !== "function") return "plaintext";
	return await params.prompter.select({
		message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
		initialValue: "plaintext",
		options: [{
			value: "plaintext",
			label: params.copy?.plaintextLabel ?? "Paste API key now",
			hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config"
		}, {
			value: "ref",
			label: params.copy?.refLabel ?? "Use external secret provider",
			hint: params.copy?.refHint ?? "Stores a reference to env or configured external secret providers"
		}]
	}) === "ref" ? "ref" : "plaintext";
}
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
function buildSingleChannelSecretPromptState(params) {
	return {
		accountConfigured: params.accountConfigured,
		hasConfigToken: params.hasConfigToken,
		canUseEnv: params.allowEnv && Boolean(params.envValue?.trim()) && !params.hasConfigToken
	};
}
async function promptSingleChannelToken(params) {
	const promptToken = async () => String(await params.prompter.text({
		message: params.inputPrompt,
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
	if (params.canUseEnv) {
		if (await params.prompter.confirm({
			message: params.envPrompt,
			initialValue: true
		})) return {
			useEnv: true,
			token: null
		};
		return {
			useEnv: false,
			token: await promptToken()
		};
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return {
			useEnv: false,
			token: null
		};
	}
	return {
		useEnv: false,
		token: await promptToken()
	};
}
async function promptSingleChannelSecretInput(params) {
	if (await resolveSecretInputModeForEnvSelection({
		prompter: params.prompter,
		explicitMode: params.secretInputMode,
		copy: {
			modeMessage: `How do you want to provide this ${params.credentialLabel}?`,
			plaintextLabel: `Enter ${params.credentialLabel}`,
			plaintextHint: "Stores the credential directly in OpenClaw config",
			refLabel: "Use external secret provider",
			refHint: "Stores a reference to env or configured external secret providers"
		}
	}) === "plaintext") {
		const plainResult = await promptSingleChannelToken({
			prompter: params.prompter,
			accountConfigured: params.accountConfigured,
			canUseEnv: params.canUseEnv,
			hasConfigToken: params.hasConfigToken,
			envPrompt: params.envPrompt,
			keepPrompt: params.keepPrompt,
			inputPrompt: params.inputPrompt
		});
		if (plainResult.useEnv) return { action: "use-env" };
		if (plainResult.token) return {
			action: "set",
			value: plainResult.token,
			resolvedValue: plainResult.token
		};
		return { action: "keep" };
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return { action: "keep" };
	}
	const resolved = await promptSecretRefForOnboarding({
		provider: params.providerHint,
		config: params.cfg,
		prompter: params.prompter,
		preferredEnvVar: params.preferredEnvVar,
		copy: {
			sourceMessage: `Where is this ${params.credentialLabel} stored?`,
			envVarPlaceholder: params.preferredEnvVar ?? "OPENCLAW_SECRET",
			envVarFormatError: "Use an env var name like \"OPENCLAW_SECRET\" (uppercase letters, numbers, underscores).",
			noProvidersMessage: "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable."
		}
	});
	return {
		action: "set",
		value: resolved.ref,
		resolvedValue: resolved.resolvedValue
	};
}
//#endregion
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/plugin-sdk/secret-input-schema.ts
function buildSecretInputSchema() {
	const providerSchema = z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\").");
	return z.union([z.string(), z.discriminatedUnion("source", [
		z.object({
			source: z.literal("env"),
			provider: providerSchema,
			id: z.string().regex(ENV_SECRET_REF_ID_RE, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
		}),
		z.object({
			source: z.literal("file"),
			provider: providerSchema,
			id: z.string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
		}),
		z.object({
			source: z.literal("exec"),
			provider: providerSchema,
			id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
		})
	])]);
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
//#region src/plugin-sdk/agent-media-payload.ts
function buildAgentMediaPayload(mediaList) {
	const first = mediaList[0];
	const mediaPaths = mediaList.map((media) => media.path);
	const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean);
	return {
		MediaPath: first?.path,
		MediaType: first?.contentType ?? void 0,
		MediaUrl: first?.path,
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaUrls: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0
	};
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
//#region src/plugin-sdk/persistent-dedupe.ts
const DEFAULT_LOCK_OPTIONS = {
	retries: {
		retries: 6,
		factor: 1.35,
		minTimeout: 8,
		maxTimeout: 180,
		randomize: true
	},
	stale: 6e4
};
function mergeLockOptions(overrides) {
	return {
		stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
		retries: {
			retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
			factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
			minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
			maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
			randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize
		}
	};
}
function sanitizeData(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, ts] of Object.entries(value)) if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) out[key] = ts;
	return out;
}
function pruneData(data, now, ttlMs, maxEntries) {
	if (ttlMs > 0) {
		for (const [key, ts] of Object.entries(data)) if (now - ts >= ttlMs) delete data[key];
	}
	const keys = Object.keys(data);
	if (keys.length <= maxEntries) return;
	keys.toSorted((a, b) => data[a] - data[b]).slice(0, keys.length - maxEntries).forEach((key) => {
		delete data[key];
	});
}
function createPersistentDedupe(options) {
	const ttlMs = Math.max(0, Math.floor(options.ttlMs));
	const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
	const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
	const lockOptions = mergeLockOptions(options.lockOptions);
	const memory = createDedupeCache({
		ttlMs,
		maxSize: memoryMaxSize
	});
	const inflight = /* @__PURE__ */ new Map();
	async function checkAndRecordInner(key, namespace, scopedKey, now, onDiskError) {
		if (memory.check(scopedKey, now)) return false;
		const path = options.resolveFilePath(namespace);
		try {
			return !await withFileLock(path, lockOptions, async () => {
				const { value } = await readJsonFileWithFallback(path, {});
				const data = sanitizeData(value);
				const seenAt = data[key];
				if (seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs)) return true;
				data[key] = now;
				pruneData(data, now, ttlMs, fileMaxEntries);
				await writeJsonFileAtomically(path, data);
				return false;
			});
		} catch (error) {
			onDiskError?.(error);
			memory.check(scopedKey, now);
			return true;
		}
	}
	async function warmup(namespace = "global", onError) {
		const filePath = options.resolveFilePath(namespace);
		const now = Date.now();
		try {
			const { value } = await readJsonFileWithFallback(filePath, {});
			const data = sanitizeData(value);
			let loaded = 0;
			for (const [key, ts] of Object.entries(data)) {
				if (ttlMs > 0 && now - ts >= ttlMs) continue;
				const scopedKey = `${namespace}:${key}`;
				memory.check(scopedKey, ts);
				loaded++;
			}
			return loaded;
		} catch (error) {
			onError?.(error);
			return 0;
		}
	}
	async function checkAndRecord(key, dedupeOptions) {
		const trimmed = key.trim();
		if (!trimmed) return true;
		const namespace = dedupeOptions?.namespace?.trim() || "global";
		const scopedKey = `${namespace}:${trimmed}`;
		if (inflight.has(scopedKey)) return false;
		const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
		const work = checkAndRecordInner(trimmed, namespace, scopedKey, dedupeOptions?.now ?? Date.now(), onDiskError);
		inflight.set(scopedKey, work);
		try {
			return await work;
		} finally {
			inflight.delete(scopedKey);
		}
	}
	return {
		checkAndRecord,
		warmup,
		clearMemory: () => memory.clear(),
		memorySize: () => memory.size()
	};
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
//#region src/plugin-sdk/webhook-memory-guards.ts
const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
	windowMs: 6e4,
	maxRequests: 120,
	maxTrackedKeys: 4096
});
const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
	maxTrackedKeys: 4096,
	ttlMs: 360 * 6e4,
	logEvery: 25
});
const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([
	400,
	401,
	408,
	413,
	415,
	429
]);
function createFixedWindowRateLimiter(options) {
	const windowMs = Math.max(1, Math.floor(options.windowMs));
	const maxRequests = Math.max(1, Math.floor(options.maxRequests));
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? windowMs));
	const state = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		state.delete(key);
		state.set(key, value);
	};
	const prune = (nowMs) => {
		for (const [key, entry] of state) if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
	};
	return {
		isRateLimited: (key, nowMs = Date.now()) => {
			if (!key) return false;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = state.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) {
				touch(key, {
					count: 1,
					windowStartMs: nowMs
				});
				pruneMapToMaxSize(state, maxTrackedKeys);
				return false;
			}
			const nextCount = existing.count + 1;
			touch(key, {
				count: nextCount,
				windowStartMs: existing.windowStartMs
			});
			pruneMapToMaxSize(state, maxTrackedKeys);
			return nextCount > maxRequests;
		},
		size: () => state.size,
		clear: () => {
			state.clear();
			lastPruneMs = 0;
		}
	};
}
function createBoundedCounter(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options.ttlMs ?? 0));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? (ttlMs > 0 ? ttlMs : 6e4)));
	const counters = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		counters.delete(key);
		counters.set(key, value);
	};
	const isExpired = (entry, nowMs) => ttlMs > 0 && nowMs - entry.updatedAtMs >= ttlMs;
	const prune = (nowMs) => {
		if (ttlMs > 0) {
			for (const [key, entry] of counters) if (isExpired(entry, nowMs)) counters.delete(key);
		}
	};
	return {
		increment: (key, nowMs = Date.now()) => {
			if (!key) return 0;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = counters.get(key);
			const nextCount = (existing && !isExpired(existing, nowMs) ? existing.count : 0) + 1;
			touch(key, {
				count: nextCount,
				updatedAtMs: nowMs
			});
			pruneMapToMaxSize(counters, maxTrackedKeys);
			return nextCount;
		},
		size: () => counters.size,
		clear: () => {
			counters.clear();
			lastPruneMs = 0;
		}
	};
}
function createWebhookAnomalyTracker(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options?.maxTrackedKeys ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options?.ttlMs ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs));
	const logEvery = Math.max(1, Math.floor(options?.logEvery ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery));
	const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
	const counter = createBoundedCounter({
		maxTrackedKeys,
		ttlMs
	});
	return {
		record: ({ key, statusCode, message, log, nowMs }) => {
			if (!trackedStatusCodes.has(statusCode)) return 0;
			const next = counter.increment(key, nowMs);
			if (log && (next === 1 || next % logEvery === 0)) log(message(next));
			return next;
		},
		size: () => counter.size(),
		clear: () => counter.clear()
	};
}
Object.freeze({
	preAuth: {
		maxBytes: 64 * 1024,
		timeoutMs: 5e3
	},
	postAuth: {
		maxBytes: 1024 * 1024,
		timeoutMs: 3e4
	}
});
Object.freeze({
	maxInFlightPerKey: 8,
	maxTrackedKeys: 4096
});
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
//#endregion
export { DEFAULT_ACCOUNT_ID, DEFAULT_GROUP_HISTORY_LIMIT, PAIRING_APPROVED_MESSAGE, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, addWildcardAllowFrom, applyBasicWebhookRequestGuards, buildAgentMediaPayload, buildBaseChannelStatusSummary, buildPendingHistoryContextFromMap, buildProbeChannelStatusSummary, buildRuntimeAccountStatusSnapshot, buildSecretInputSchema, buildSingleChannelSecretPromptState, clearHistoryEntriesIfEnabled, createDedupeCache, createDefaultChannelRuntimeState, createFixedWindowRateLimiter, createPersistentDedupe, createReplyPrefixContext, createScopedPairingAccess, createTypingCallbacks, createWebhookAnomalyTracker, emptyPluginConfigSchema, evaluateSenderGroupAccessForPolicy, fetchWithSsrFGuard, formatDocsLink, hasConfiguredSecretInput, installRequestBodyLimitGuard, issuePairingChallenge, logTypingFailure, mergeAllowFromEntries, normalizeAgentId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonBodyWithLimit, readJsonFileWithFallback, recordPendingHistoryEntryIfEnabled, resolveAllowlistProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy, setTopLevelChannelAllowFrom, setTopLevelChannelDmPolicyWithAllowFrom, setTopLevelChannelGroupPolicy, splitOnboardingEntries, warnMissingProviderGroupPolicyFallbackOnce, withTempDownloadPath };
