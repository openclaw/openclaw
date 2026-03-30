import { $t as resolveStateDir } from "./entry.js";
import { $r as DEFAULT_PROVIDER, Dn as resolveOpenClawAgentDir, Gn as resolveConfiguredModelRef, Hn as parseModelRef, In as inferUniqueProviderFromConfiguredModels, Kn as resolveDefaultModelForAgent, Qr as DEFAULT_MODEL, Zr as DEFAULT_CONTEXT_TOKENS, at as AVATAR_MAX_BYTES, dt as isWorkspaceRelativeAvatarPath, j as loadConfig, lt as isPathWithinRoot, ot as isAvatarDataUrl, pt as resolveAvatarMime, st as isAvatarHttpUrl } from "./auth-profiles-D6H-HVV8.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { c as normalizeMainKey, s as normalizeAgentId, w as parseAgentSessionKey, x as isCronRunSessionKey } from "./session-key-qmb11-mH.js";
import { a as openBoundaryFileSync } from "./openclaw-root-C9tYgTzw.js";
import { $ as resolveAgentMainSessionKey, M as readSessionTitleFieldsFromTranscript, Q as canonicalizeMainSessionAlias, X as resolveFreshSessionTotalTokens, c as loadSessionStore, st as buildGroupDisplayName, tt as resolveMainSessionKey, w as normalizeSessionDeliveryFields } from "./sessions-B8Y6oyPb.js";
import { l as resolveStorePath } from "./paths-DWsXK0S0.js";
import { t as ensureOpenClawModelsJson } from "./models-config-Cm28W4wc.js";
import path from "node:path";
import fs from "node:fs";

//#region src/agents/context.ts
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"];
const ANTHROPIC_CONTEXT_1M_TOKENS = 1048576;
function applyDiscoveredContextWindows(params) {
	for (const model of params.models) {
		if (!model?.id) continue;
		const contextWindow = typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : void 0;
		if (!contextWindow || contextWindow <= 0) continue;
		const existing = params.cache.get(model.id);
		if (existing === void 0 || contextWindow < existing) params.cache.set(model.id, contextWindow);
	}
}
function applyConfiguredContextWindows(params) {
	const providers = params.modelsConfig?.providers;
	if (!providers || typeof providers !== "object") return;
	for (const provider of Object.values(providers)) {
		if (!Array.isArray(provider?.models)) continue;
		for (const model of provider.models) {
			const modelId = typeof model?.id === "string" ? model.id : void 0;
			const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : void 0;
			if (!modelId || !contextWindow || contextWindow <= 0) continue;
			params.cache.set(modelId, contextWindow);
		}
	}
}
const MODEL_CACHE = /* @__PURE__ */ new Map();
(async () => {
	let cfg;
	try {
		cfg = loadConfig();
	} catch {
		return;
	}
	try {
		await ensureOpenClawModelsJson(cfg);
	} catch {}
	try {
		const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery-D0GqAM5X.js").then((n) => n.r);
		const agentDir = resolveOpenClawAgentDir();
		const modelRegistry = discoverModels(discoverAuthStorage(agentDir), agentDir);
		applyDiscoveredContextWindows({
			cache: MODEL_CACHE,
			models: typeof modelRegistry.getAvailable === "function" ? modelRegistry.getAvailable() : modelRegistry.getAll()
		});
	} catch {}
	applyConfiguredContextWindows({
		cache: MODEL_CACHE,
		modelsConfig: cfg.models
	});
})().catch(() => {});
function lookupContextTokens(modelId) {
	if (!modelId) return;
	return MODEL_CACHE.get(modelId);
}
function resolveConfiguredModelParams(cfg, provider, model) {
	const models = cfg?.agents?.defaults?.models;
	if (!models) return;
	const key = `${provider}/${model}`.trim().toLowerCase();
	for (const [rawKey, entry] of Object.entries(models)) if (rawKey.trim().toLowerCase() === key) {
		const params = entry?.params;
		return params && typeof params === "object" ? params : void 0;
	}
}
function resolveProviderModelRef(params) {
	const modelRaw = params.model?.trim();
	if (!modelRaw) return;
	const providerRaw = params.provider?.trim();
	if (providerRaw) return {
		provider: providerRaw.toLowerCase(),
		model: modelRaw
	};
	const slash = modelRaw.indexOf("/");
	if (slash <= 0) return;
	const provider = modelRaw.slice(0, slash).trim().toLowerCase();
	const model = modelRaw.slice(slash + 1).trim();
	if (!provider || !model) return;
	return {
		provider,
		model
	};
}
function isAnthropic1MModel(provider, model) {
	if (provider !== "anthropic") return false;
	const normalized = model.trim().toLowerCase();
	const modelId = normalized.includes("/") ? normalized.split("/").at(-1) ?? normalized : normalized;
	return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
function resolveContextTokensForModel(params) {
	if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) return params.contextTokensOverride;
	const ref = resolveProviderModelRef({
		provider: params.provider,
		model: params.model
	});
	if (ref) {
		if (resolveConfiguredModelParams(params.cfg, ref.provider, ref.model)?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) return ANTHROPIC_CONTEXT_1M_TOKENS;
	}
	return lookupContextTokens(params.model) ?? params.fallbackContextTokens;
}

//#endregion
//#region src/gateway/session-utils.ts
const DERIVED_TITLE_MAX_LEN = 60;
function tryResolveExistingPath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return null;
	}
}
function resolveIdentityAvatarUrl(cfg, agentId, avatar) {
	if (!avatar) return;
	const trimmed = avatar.trim();
	if (!trimmed) return;
	if (isAvatarDataUrl(trimmed) || isAvatarHttpUrl(trimmed)) return trimmed;
	if (!isWorkspaceRelativeAvatarPath(trimmed)) return;
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	const workspaceRoot = tryResolveExistingPath(workspaceDir) ?? path.resolve(workspaceDir);
	const resolvedCandidate = path.resolve(workspaceRoot, trimmed);
	if (!isPathWithinRoot(workspaceRoot, resolvedCandidate)) return;
	try {
		const opened = openBoundaryFileSync({
			absolutePath: resolvedCandidate,
			rootPath: workspaceRoot,
			rootRealPath: workspaceRoot,
			boundaryLabel: "workspace root",
			maxBytes: AVATAR_MAX_BYTES,
			skipLexicalRootCheck: true
		});
		if (!opened.ok) return;
		try {
			const buffer = fs.readFileSync(opened.fd);
			return `data:${resolveAvatarMime(resolvedCandidate)};base64,${buffer.toString("base64")}`;
		} finally {
			fs.closeSync(opened.fd);
		}
	} catch {
		return;
	}
}
function formatSessionIdPrefix(sessionId, updatedAt) {
	const prefix = sessionId.slice(0, 8);
	if (updatedAt && updatedAt > 0) return `${prefix} (${new Date(updatedAt).toISOString().slice(0, 10)})`;
	return prefix;
}
function truncateTitle(text, maxLen) {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > maxLen * .6) return cut.slice(0, lastSpace) + "…";
	return cut + "…";
}
function deriveSessionTitle(entry, firstUserMessage) {
	if (!entry) return;
	if (entry.displayName?.trim()) return entry.displayName.trim();
	if (entry.subject?.trim()) return entry.subject.trim();
	if (firstUserMessage?.trim()) return truncateTitle(firstUserMessage.replace(/\s+/g, " ").trim(), DERIVED_TITLE_MAX_LEN);
	if (entry.sessionId) return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
}
function loadSessionEntry(sessionKey) {
	const cfg = loadConfig();
	const sessionCfg = cfg.session;
	const canonicalKey = resolveSessionStoreKey({
		cfg,
		sessionKey
	});
	const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
	const storePath = resolveStorePath(sessionCfg?.store, { agentId });
	const store = loadSessionStore(storePath);
	const match = findStoreMatch(store, canonicalKey, sessionKey.trim());
	const legacyKey = match?.key !== canonicalKey ? match?.key : void 0;
	return {
		cfg,
		storePath,
		store,
		entry: match?.entry,
		canonicalKey,
		legacyKey
	};
}
/**
* Find a session entry by exact or case-insensitive key match.
* Returns both the entry and the actual store key it was found under,
* so callers can clean up legacy mixed-case keys when they differ from canonicalKey.
*/
function findStoreMatch(store, ...candidates) {
	for (const candidate of candidates) if (candidate && store[candidate]) return {
		entry: store[candidate],
		key: candidate
	};
	const loweredSet = new Set(candidates.filter(Boolean).map((c) => c.toLowerCase()));
	for (const key of Object.keys(store)) if (loweredSet.has(key.toLowerCase())) return {
		entry: store[key],
		key
	};
}
/**
* Find all on-disk store keys that match the given key case-insensitively.
* Returns every key from the store whose lowercased form equals the target's lowercased form.
*/
function findStoreKeysIgnoreCase(store, targetKey) {
	const lowered = targetKey.toLowerCase();
	const matches = [];
	for (const key of Object.keys(store)) if (key.toLowerCase() === lowered) matches.push(key);
	return matches;
}
/**
* Remove legacy key variants for one canonical session key.
* Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
*/
function pruneLegacyStoreKeys(params) {
	const keysToDelete = /* @__PURE__ */ new Set();
	for (const candidate of params.candidates) {
		const trimmed = String(candidate ?? "").trim();
		if (!trimmed) continue;
		if (trimmed !== params.canonicalKey) keysToDelete.add(trimmed);
		for (const match of findStoreKeysIgnoreCase(params.store, trimmed)) if (match !== params.canonicalKey) keysToDelete.add(match);
	}
	for (const key of keysToDelete) delete params.store[key];
}
function classifySessionKey(key, entry) {
	if (key === "global") return "global";
	if (key === "unknown") return "unknown";
	if (entry?.chatType === "group" || entry?.chatType === "channel") return "group";
	if (key.includes(":group:") || key.includes(":channel:")) return "group";
	return "direct";
}
function parseGroupKey(key) {
	const parts = (parseAgentSessionKey(key)?.rest ?? key).split(":").filter(Boolean);
	if (parts.length >= 3) {
		const [channel, kind, ...rest] = parts;
		if (kind === "group" || kind === "channel") return {
			channel,
			kind,
			id: rest.join(":")
		};
	}
	return null;
}
function isStorePathTemplate(store) {
	return typeof store === "string" && store.includes("{agentId}");
}
function listExistingAgentIdsFromDisk() {
	const root = resolveStateDir();
	const agentsDir = path.join(root, "agents");
	try {
		return fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => normalizeAgentId(entry.name)).filter(Boolean);
	} catch {
		return [];
	}
}
function listConfiguredAgentIds(cfg) {
	const agents = cfg.agents?.list ?? [];
	if (agents.length > 0) {
		const ids = /* @__PURE__ */ new Set();
		for (const entry of agents) if (entry?.id) ids.add(normalizeAgentId(entry.id));
		const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
		ids.add(defaultId);
		const sorted = Array.from(ids).filter(Boolean);
		sorted.sort((a, b) => a.localeCompare(b));
		return sorted.includes(defaultId) ? [defaultId, ...sorted.filter((id) => id !== defaultId)] : sorted;
	}
	const ids = /* @__PURE__ */ new Set();
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	ids.add(defaultId);
	for (const id of listExistingAgentIdsFromDisk()) ids.add(id);
	const sorted = Array.from(ids).filter(Boolean);
	sorted.sort((a, b) => a.localeCompare(b));
	if (sorted.includes(defaultId)) return [defaultId, ...sorted.filter((id) => id !== defaultId)];
	return sorted;
}
function listAgentsForGateway(cfg) {
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const scope = cfg.session?.scope ?? "per-sender";
	const configuredById = /* @__PURE__ */ new Map();
	for (const entry of cfg.agents?.list ?? []) {
		if (!entry?.id) continue;
		const identity = entry.identity ? {
			name: entry.identity.name?.trim() || void 0,
			theme: entry.identity.theme?.trim() || void 0,
			emoji: entry.identity.emoji?.trim() || void 0,
			avatar: entry.identity.avatar?.trim() || void 0,
			avatarUrl: resolveIdentityAvatarUrl(cfg, normalizeAgentId(entry.id), entry.identity.avatar?.trim())
		} : void 0;
		configuredById.set(normalizeAgentId(entry.id), {
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : void 0,
			identity
		});
	}
	const explicitIds = new Set((cfg.agents?.list ?? []).map((entry) => entry?.id ? normalizeAgentId(entry.id) : "").filter(Boolean));
	const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
	let agentIds = listConfiguredAgentIds(cfg).filter((id) => allowedIds ? allowedIds.has(id) : true);
	if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) agentIds = [...agentIds, mainKey];
	return {
		defaultId,
		mainKey,
		scope,
		agents: agentIds.map((id) => {
			const meta = configuredById.get(id);
			return {
				id,
				name: meta?.name,
				identity: meta?.identity
			};
		})
	};
}
function canonicalizeSessionKeyForAgent(agentId, key) {
	const lowered = key.toLowerCase();
	if (lowered === "global" || lowered === "unknown") return lowered;
	if (lowered.startsWith("agent:")) return lowered;
	return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}
function resolveDefaultStoreAgentId(cfg) {
	return normalizeAgentId(resolveDefaultAgentId(cfg));
}
function resolveSessionStoreKey(params) {
	const raw = (params.sessionKey ?? "").trim();
	if (!raw) return raw;
	const rawLower = raw.toLowerCase();
	if (rawLower === "global" || rawLower === "unknown") return rawLower;
	const parsed = parseAgentSessionKey(raw);
	if (parsed) {
		const agentId = normalizeAgentId(parsed.agentId);
		const lowered = raw.toLowerCase();
		const canonical = canonicalizeMainSessionAlias({
			cfg: params.cfg,
			agentId,
			sessionKey: lowered
		});
		if (canonical !== lowered) return canonical;
		return lowered;
	}
	const lowered = raw.toLowerCase();
	const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
	if (lowered === "main" || lowered === rawMainKey) return resolveMainSessionKey(params.cfg);
	return canonicalizeSessionKeyForAgent(resolveDefaultStoreAgentId(params.cfg), lowered);
}
function resolveSessionStoreAgentId(cfg, canonicalKey) {
	if (canonicalKey === "global" || canonicalKey === "unknown") return resolveDefaultStoreAgentId(cfg);
	const parsed = parseAgentSessionKey(canonicalKey);
	if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
	return resolveDefaultStoreAgentId(cfg);
}
function canonicalizeSpawnedByForAgent(cfg, agentId, spawnedBy) {
	const raw = spawnedBy?.trim();
	if (!raw) return;
	const lower = raw.toLowerCase();
	if (lower === "global" || lower === "unknown") return lower;
	let result;
	if (raw.toLowerCase().startsWith("agent:")) result = raw.toLowerCase();
	else result = `agent:${normalizeAgentId(agentId)}:${lower}`;
	const parsed = parseAgentSessionKey(result);
	return canonicalizeMainSessionAlias({
		cfg,
		agentId: parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId,
		sessionKey: result
	});
}
function resolveGatewaySessionStoreTarget(params) {
	const key = params.key.trim();
	const canonicalKey = resolveSessionStoreKey({
		cfg: params.cfg,
		sessionKey: key
	});
	const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
	const storeConfig = params.cfg.session?.store;
	const storePath = resolveStorePath(storeConfig, { agentId });
	if (canonicalKey === "global" || canonicalKey === "unknown") return {
		agentId,
		storePath,
		canonicalKey,
		storeKeys: key && key !== canonicalKey ? [canonicalKey, key] : [key]
	};
	const storeKeys = /* @__PURE__ */ new Set();
	storeKeys.add(canonicalKey);
	if (key && key !== canonicalKey) storeKeys.add(key);
	if (params.scanLegacyKeys !== false) {
		const scanTargets = new Set(storeKeys);
		if (canonicalKey === resolveAgentMainSessionKey({
			cfg: params.cfg,
			agentId
		})) scanTargets.add(`agent:${agentId}:main`);
		const store = params.store ?? loadSessionStore(storePath);
		for (const seed of scanTargets) for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) storeKeys.add(legacyKey);
	}
	return {
		agentId,
		storePath,
		canonicalKey,
		storeKeys: Array.from(storeKeys)
	};
}
function mergeSessionEntryIntoCombined(params) {
	const { cfg, combined, entry, agentId, canonicalKey } = params;
	const existing = combined[canonicalKey];
	if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) combined[canonicalKey] = {
		...entry,
		...existing,
		spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy)
	};
	else combined[canonicalKey] = {
		...existing,
		...entry,
		spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, entry.spawnedBy ?? existing?.spawnedBy)
	};
}
function loadCombinedSessionStoreForGateway(cfg) {
	const storeConfig = cfg.session?.store;
	if (storeConfig && !isStorePathTemplate(storeConfig)) {
		const storePath = resolveStorePath(storeConfig);
		const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
		const store = loadSessionStore(storePath);
		const combined = {};
		for (const [key, entry] of Object.entries(store)) mergeSessionEntryIntoCombined({
			cfg,
			combined,
			entry,
			agentId: defaultAgentId,
			canonicalKey: canonicalizeSessionKeyForAgent(defaultAgentId, key)
		});
		return {
			storePath,
			store: combined
		};
	}
	const agentIds = listConfiguredAgentIds(cfg);
	const combined = {};
	for (const agentId of agentIds) {
		const store = loadSessionStore(resolveStorePath(storeConfig, { agentId }));
		for (const [key, entry] of Object.entries(store)) mergeSessionEntryIntoCombined({
			cfg,
			combined,
			entry,
			agentId,
			canonicalKey: canonicalizeSessionKeyForAgent(agentId, key)
		});
	}
	return {
		storePath: typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)",
		store: combined
	};
}
function getSessionDefaults(cfg) {
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const contextTokens = cfg.agents?.defaults?.contextTokens ?? lookupContextTokens(resolved.model) ?? DEFAULT_CONTEXT_TOKENS;
	return {
		modelProvider: resolved.provider ?? null,
		model: resolved.model ?? null,
		contextTokens: contextTokens ?? null
	};
}
function resolveSessionModelRef(cfg, entry, agentId) {
	const resolved = agentId ? resolveDefaultModelForAgent({
		cfg,
		agentId
	}) : resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	let provider = resolved.provider;
	let model = resolved.model;
	const runtimeModel = entry?.model?.trim();
	const runtimeProvider = entry?.modelProvider?.trim();
	if (runtimeModel) {
		if (runtimeProvider) return {
			provider: runtimeProvider,
			model: runtimeModel
		};
		const parsedRuntime = parseModelRef(runtimeModel, provider || DEFAULT_PROVIDER);
		if (parsedRuntime) {
			provider = parsedRuntime.provider;
			model = parsedRuntime.model;
		} else model = runtimeModel;
		return {
			provider,
			model
		};
	}
	const storedModelOverride = entry?.modelOverride?.trim();
	if (storedModelOverride) {
		const overrideProvider = entry?.providerOverride?.trim() || provider || DEFAULT_PROVIDER;
		const parsedOverride = parseModelRef(storedModelOverride, overrideProvider);
		if (parsedOverride) {
			provider = parsedOverride.provider;
			model = parsedOverride.model;
		} else {
			provider = overrideProvider;
			model = storedModelOverride;
		}
	}
	return {
		provider,
		model
	};
}
function resolveSessionModelIdentityRef(cfg, entry, agentId) {
	const runtimeModel = entry?.model?.trim();
	const runtimeProvider = entry?.modelProvider?.trim();
	if (runtimeModel) {
		if (runtimeProvider) return {
			provider: runtimeProvider,
			model: runtimeModel
		};
		const inferredProvider = inferUniqueProviderFromConfiguredModels({
			cfg,
			model: runtimeModel
		});
		if (inferredProvider) return {
			provider: inferredProvider,
			model: runtimeModel
		};
		if (runtimeModel.includes("/")) {
			const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER);
			if (parsedRuntime) return {
				provider: parsedRuntime.provider,
				model: parsedRuntime.model
			};
			return { model: runtimeModel };
		}
		return { model: runtimeModel };
	}
	const resolved = resolveSessionModelRef(cfg, entry, agentId);
	return {
		provider: resolved.provider,
		model: resolved.model
	};
}
function listSessionsFromStore(params) {
	const { cfg, storePath, store, opts } = params;
	const now = Date.now();
	const includeGlobal = opts.includeGlobal === true;
	const includeUnknown = opts.includeUnknown === true;
	const includeDerivedTitles = opts.includeDerivedTitles === true;
	const includeLastMessage = opts.includeLastMessage === true;
	const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
	const label = typeof opts.label === "string" ? opts.label.trim() : "";
	const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
	const search = typeof opts.search === "string" ? opts.search.trim().toLowerCase() : "";
	const activeMinutes = typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes) ? Math.max(1, Math.floor(opts.activeMinutes)) : void 0;
	let sessions = Object.entries(store).filter(([key]) => {
		if (isCronRunSessionKey(key)) return false;
		if (!includeGlobal && key === "global") return false;
		if (!includeUnknown && key === "unknown") return false;
		if (agentId) {
			if (key === "global" || key === "unknown") return false;
			const parsed = parseAgentSessionKey(key);
			if (!parsed) return false;
			return normalizeAgentId(parsed.agentId) === agentId;
		}
		return true;
	}).filter(([key, entry]) => {
		if (!spawnedBy) return true;
		if (key === "unknown" || key === "global") return false;
		return entry?.spawnedBy === spawnedBy;
	}).filter(([, entry]) => {
		if (!label) return true;
		return entry?.label === label;
	}).map(([key, entry]) => {
		const updatedAt = entry?.updatedAt ?? null;
		const total = resolveFreshSessionTotalTokens(entry);
		const totalTokensFresh = typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
		const parsed = parseGroupKey(key);
		const channel = entry?.channel ?? parsed?.channel;
		const subject = entry?.subject;
		const groupChannel = entry?.groupChannel;
		const space = entry?.space;
		const id = parsed?.id;
		const origin = entry?.origin;
		const originLabel = origin?.label;
		const displayName = entry?.displayName ?? (channel ? buildGroupDisplayName({
			provider: channel,
			subject,
			groupChannel,
			space,
			id,
			key
		}) : void 0) ?? entry?.label ?? originLabel;
		const deliveryFields = normalizeSessionDeliveryFields(entry);
		const resolvedModel = resolveSessionModelIdentityRef(cfg, entry, normalizeAgentId(parseAgentSessionKey(key)?.agentId ?? resolveDefaultAgentId(cfg)));
		const modelProvider = resolvedModel.provider;
		const model = resolvedModel.model ?? DEFAULT_MODEL;
		return {
			key,
			entry,
			kind: classifySessionKey(key, entry),
			label: entry?.label,
			displayName,
			channel,
			subject,
			groupChannel,
			space,
			chatType: entry?.chatType,
			origin,
			updatedAt,
			sessionId: entry?.sessionId,
			systemSent: entry?.systemSent,
			abortedLastRun: entry?.abortedLastRun,
			thinkingLevel: entry?.thinkingLevel,
			verboseLevel: entry?.verboseLevel,
			reasoningLevel: entry?.reasoningLevel,
			elevatedLevel: entry?.elevatedLevel,
			sendPolicy: entry?.sendPolicy,
			inputTokens: entry?.inputTokens,
			outputTokens: entry?.outputTokens,
			totalTokens: total,
			totalTokensFresh,
			responseUsage: entry?.responseUsage,
			modelProvider,
			model,
			contextTokens: entry?.contextTokens,
			deliveryContext: deliveryFields.deliveryContext,
			lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
			lastTo: deliveryFields.lastTo ?? entry?.lastTo,
			lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId
		};
	}).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	if (search) sessions = sessions.filter((s) => {
		return [
			s.displayName,
			s.label,
			s.subject,
			s.sessionId,
			s.key
		].some((f) => typeof f === "string" && f.toLowerCase().includes(search));
	});
	if (activeMinutes !== void 0) {
		const cutoff = now - activeMinutes * 6e4;
		sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
	}
	if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
		const limit = Math.max(1, Math.floor(opts.limit));
		sessions = sessions.slice(0, limit);
	}
	const finalSessions = sessions.map((s) => {
		const { entry, ...rest } = s;
		let derivedTitle;
		let lastMessagePreview;
		if (entry?.sessionId) {
			if (includeDerivedTitles || includeLastMessage) {
				const parsed = parseAgentSessionKey(s.key);
				const agentId = parsed && parsed.agentId ? normalizeAgentId(parsed.agentId) : resolveDefaultAgentId(cfg);
				const fields = readSessionTitleFieldsFromTranscript(entry.sessionId, storePath, entry.sessionFile, agentId);
				if (includeDerivedTitles) derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
				if (includeLastMessage && fields.lastMessagePreview) lastMessagePreview = fields.lastMessagePreview;
			}
		}
		return {
			...rest,
			derivedTitle,
			lastMessagePreview
		};
	});
	return {
		ts: now,
		path: storePath,
		count: finalSessions.length,
		defaults: getSessionDefaults(cfg),
		sessions: finalSessions
	};
}

//#endregion
export { loadCombinedSessionStoreForGateway as a, resolveGatewaySessionStoreTarget as c, resolveContextTokensForModel as d, listSessionsFromStore as i, resolveSessionModelRef as l, classifySessionKey as n, loadSessionEntry as o, listAgentsForGateway as r, pruneLegacyStoreKeys as s, canonicalizeSpawnedByForAgent as t, lookupContextTokens as u };