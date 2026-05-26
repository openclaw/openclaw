import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { o as resolveRequiredHomeDir } from "./home-dir-BOPFpGo8.js";
import { _ as resolveOAuthDir, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { u as resolveAgentModelFallbacksOverride } from "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId, v as toAgentStoreSessionKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds, r as resolveAgentConfig, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { t as asNullableObjectRecord } from "./record-coerce-aMlBWINm.js";
import { i as resolveMainSessionKey, t as canonicalizeMainSessionAlias } from "./main-session-D3q_5w0B.js";
import { r as isPrimarySessionTranscriptFileName, t as formatSessionArchiveTimestamp } from "./artifacts-BZhcmsUl.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, l as resolveSessionTranscriptsDirForAgent, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { i as parseModelRef, n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { i as isSubagentRecoveryWedgedEntry, r as formatSubagentRecoveryWedgedReason, t as clearWedgedSubagentRecoveryAbort } from "./subagent-recovery-state-Chw_zLIZ.js";
import "./selection-hR-AeOeU.js";
import { n as isHeartbeatOkResponse, r as isHeartbeatUserMessage } from "./heartbeat-filter-Crwj3kBD.js";
import { n as resolveHeartbeatIntervalMs } from "./heartbeat-summary-DSUstNmc.js";
import { f as listConfiguredChannelIdsForReadOnlyScope } from "./channel-plugin-ids-nB-ga3MN.js";
import { t as resolveHeartbeatDeliveryTarget } from "./targets-CNDTJ9IB.js";
import { t as resolveOpenClawAgentDir } from "./agent-dir-compat-_xK_EqIx.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as resolveMemoryBackendConfig } from "./backend-config-9Mpek5eW.js";
import "./engine-storage-Dql4GNKy.js";
import { a as listPluginDoctorSessionRouteStateOwners } from "./doctor-contract-registry-MGGe8kxH.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/commands/doctor-heartbeat-main-session-repair.ts
function countLabel$2(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
function existsFile$1(filePath) {
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function sessionEntryHasSyntheticHeartbeatOwnership(entry) {
	return typeof entry.heartbeatIsolatedBaseSessionKey === "string" && entry.heartbeatIsolatedBaseSessionKey.trim().length > 0;
}
function parseTranscriptMessageLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const record = asNullableObjectRecord(parsed);
	if (!record) return null;
	const message = asNullableObjectRecord(record.message) ?? record;
	const role = message.role;
	if (typeof role !== "string") return null;
	return {
		role,
		content: message.content
	};
}
function summarizeTranscriptHeartbeatMessages(transcriptPath) {
	let raw;
	try {
		raw = fs.readFileSync(transcriptPath, "utf8");
	} catch {
		return null;
	}
	const summary = {
		inspectedMessages: 0,
		userMessages: 0,
		heartbeatUserMessages: 0,
		nonHeartbeatUserMessages: 0,
		assistantMessages: 0,
		heartbeatOkAssistantMessages: 0
	};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const message = parseTranscriptMessageLine(trimmed);
		if (!message) continue;
		summary.inspectedMessages += 1;
		if (message.role === "user") {
			summary.userMessages += 1;
			if (isHeartbeatUserMessage(message)) summary.heartbeatUserMessages += 1;
			else summary.nonHeartbeatUserMessages += 1;
		} else if (message.role === "assistant") {
			summary.assistantMessages += 1;
			if (isHeartbeatOkResponse(message)) summary.heartbeatOkAssistantMessages += 1;
		}
	}
	return summary.inspectedMessages > 0 ? summary : null;
}
function resolveHeartbeatMainSessionRepairCandidate(params) {
	const { entry, transcriptPath } = params;
	if (!entry) return null;
	if (!(entry.lastInteractionAt === void 0)) return null;
	const hasSyntheticHeartbeatOwnership = sessionEntryHasSyntheticHeartbeatOwnership(entry);
	if (hasSyntheticHeartbeatOwnership && !transcriptPath) return { reason: "metadata" };
	if (!transcriptPath) return null;
	const summary = summarizeTranscriptHeartbeatMessages(transcriptPath);
	if (!summary) return null;
	if (summary.heartbeatUserMessages > 0 && summary.userMessages === summary.heartbeatUserMessages && summary.nonHeartbeatUserMessages === 0) return {
		reason: hasSyntheticHeartbeatOwnership ? "metadata" : "transcript",
		summary
	};
	return null;
}
function resolveHeartbeatMainRecoveryKey(params) {
	const parsed = parseAgentSessionKey(params.mainKey);
	if (!parsed) return null;
	const stamp = formatSessionArchiveTimestamp(params.nowMs).toLowerCase();
	const base = `agent:${parsed.agentId}:heartbeat-recovered-${stamp}`;
	if (!params.store[base]) return base;
	for (let index = 2; index <= 100; index += 1) {
		const candidate = `${base}-${index}`;
		if (!params.store[candidate]) return candidate;
	}
	return null;
}
function moveHeartbeatMainSessionEntry(params) {
	const entry = params.store[params.mainKey];
	if (!entry || params.store[params.recoveredKey]) return false;
	params.store[params.recoveredKey] = entry;
	delete params.store[params.mainKey];
	return true;
}
function resolveTuiLastSessionPath(stateDir) {
	return path.join(stateDir, "tui", "last-session.json");
}
function clearTuiLastSessionPointers(params) {
	if (params.sessionKeys.size === 0 || !existsFile$1(params.filePath)) return 0;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(params.filePath, "utf8"));
	} catch {
		return 0;
	}
	const store = asNullableObjectRecord(parsed);
	if (!store) return 0;
	let removed = 0;
	const next = {};
	for (const [key, value] of Object.entries(store)) {
		const sessionKey = asNullableObjectRecord(value)?.sessionKey;
		if (typeof sessionKey === "string" && params.sessionKeys.has(sessionKey)) {
			removed += 1;
			continue;
		}
		next[key] = value;
	}
	if (removed === 0) return 0;
	try {
		fs.writeFileSync(params.filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 384 });
	} catch {
		return 0;
	}
	return removed;
}
async function repairHeartbeatPoisonedMainSession(params) {
	const mainKey = resolveMainSessionKey(params.cfg);
	const mainEntry = params.store[mainKey];
	if (!mainEntry?.sessionId) return;
	let transcriptPath;
	try {
		transcriptPath = resolveSessionFilePath(mainEntry.sessionId, mainEntry, params.sessionPathOpts);
	} catch {
		transcriptPath = void 0;
	}
	const candidate = resolveHeartbeatMainSessionRepairCandidate({
		entry: mainEntry,
		transcriptPath
	});
	if (!candidate) return;
	const recoveredKey = resolveHeartbeatMainRecoveryKey({
		mainKey,
		store: params.store
	});
	if (!recoveredKey) {
		params.warnings.push(`- Main session ${mainKey} appears heartbeat-owned, but doctor could not choose a safe recovery key.`);
		return;
	}
	const reason = candidate.reason === "metadata" ? "heartbeat metadata" : `${candidate.summary?.heartbeatUserMessages ?? 0} heartbeat-only user message(s)`;
	params.warnings.push([`- Main session ${mainKey} appears to be a heartbeat-owned session (${reason}).`, `  Doctor can move it to ${recoveredKey} and let the next interactive launch create a fresh main session.`].join("\n"));
	if (!await params.prompter.confirmRuntimeRepair({
		message: `Move heartbeat-owned main session ${mainKey} to ${recoveredKey} and clear stale TUI restore pointers?`,
		initialValue: true
	})) return;
	let movedEntry;
	await updateSessionStore(params.absoluteStorePath, (currentStore) => {
		const currentEntry = currentStore[mainKey];
		if (!resolveHeartbeatMainSessionRepairCandidate({
			entry: currentEntry,
			transcriptPath
		})) return;
		if (moveHeartbeatMainSessionEntry({
			store: currentStore,
			mainKey,
			recoveredKey
		})) movedEntry = currentEntry;
	});
	if (!movedEntry) {
		params.warnings.push(`- Main session ${mainKey} changed before repair could move it.`);
		return;
	}
	params.store[recoveredKey] = movedEntry;
	delete params.store[mainKey];
	const clearedPointers = clearTuiLastSessionPointers({
		filePath: resolveTuiLastSessionPath(params.stateDir),
		sessionKeys: new Set([mainKey])
	});
	params.changes.push(`- Moved heartbeat-owned main session ${mainKey} to ${recoveredKey}.`);
	if (clearedPointers > 0) params.changes.push(`- Cleared ${countLabel$2(clearedPointers, "stale TUI last-session pointer")} for ${mainKey}.`);
}
//#endregion
//#region src/commands/doctor-heartbeat-session-target.ts
function hasExplicitHeartbeatAgents(cfg) {
	return listAgentEntries(cfg).some((entry) => Boolean(entry?.heartbeat));
}
function resolveHeartbeatConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.heartbeat;
	const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
	if (!defaults && !overrides) return overrides;
	return {
		...defaults,
		...overrides
	};
}
function listHeartbeatDoctorAgents(cfg) {
	if (hasExplicitHeartbeatAgents(cfg)) return listAgentEntries(cfg).filter((entry) => entry?.heartbeat).map((entry) => normalizeAgentId(entry.id)).filter((agentId) => agentId);
	if (cfg.agents?.defaults?.heartbeat) return listAgentIds(cfg);
	return [];
}
/**
* Detect heartbeat configs that pin a non-existent session. The runtime
* resolves `heartbeat.session` to a sessionKey via `resolveHeartbeatSession`;
* if the entry is missing, `resolveHeartbeatDeliveryTarget` falls back to
* `{channel:"none", reason:"no-target"}` and the heartbeat fires a model
* call whose reply has nowhere to land. Common cause: the configured Slack
* channel ID does not match any channel the agent has ever joined (e.g.,
* heartbeat pins channel `c0b2eddpw95` but the agent only has sessions in
* `c0ag7jag35g`, or the agent has no Slack bot at all).
*
* Warning only — repair would mean rewriting the config, which is the
* operator's intent to express.
*/
function describeHeartbeatSessionTargetIssues(cfg) {
	const warnings = [];
	const sessionScope = cfg.session?.scope ?? "per-sender";
	for (const agentId of listHeartbeatDoctorAgents(cfg)) {
		if (!agentId) continue;
		const resolvedAgentId = normalizeAgentId(agentId);
		const heartbeatConfig = resolveHeartbeatConfig(cfg, resolvedAgentId);
		if (!heartbeatConfig) continue;
		if (!resolveHeartbeatIntervalMs(cfg, void 0, heartbeatConfig)) continue;
		const configuredSession = normalizeOptionalString(heartbeatConfig.session);
		if (!configuredSession) continue;
		const normalizedSession = configuredSession.toLowerCase();
		if (normalizedSession === "main" || normalizedSession === "global") continue;
		if (isSubagentSessionKey(configuredSession)) continue;
		if (sessionScope === "global") continue;
		const target = normalizeOptionalString(heartbeatConfig.target);
		if (!target || target === "none") continue;
		const deliveryWithoutSession = resolveHeartbeatDeliveryTarget({
			cfg,
			heartbeat: heartbeatConfig
		});
		if (deliveryWithoutSession.channel !== "none" && deliveryWithoutSession.to) continue;
		const candidateSession = toAgentStoreSessionKey({
			agentId: resolvedAgentId,
			requestKey: configuredSession,
			mainKey: cfg.session?.mainKey
		});
		if (isSubagentSessionKey(candidateSession)) continue;
		const canonicalSession = canonicalizeMainSessionAlias({
			cfg,
			agentId: resolvedAgentId,
			sessionKey: candidateSession
		});
		if (canonicalSession === "global" || isSubagentSessionKey(canonicalSession) || resolveAgentIdFromSessionKey(canonicalSession) !== resolvedAgentId) continue;
		const storeAgentId = resolvedAgentId;
		const storePath = resolveStorePath(cfg.session?.store, { agentId: storeAgentId });
		if (loadSessionStore(storePath)[canonicalSession]) continue;
		warnings.push([
			`- Agent ${agentId} heartbeat.session pins ${configuredSession} (resolved to ${canonicalSession}) but that session has no entry in ${storePath}.`,
			`  Heartbeats will run but resolve delivery to channel="none"/reason="no-target", so replies are dropped silently.`,
			`  Fix: point heartbeat.session at a session the agent actually owns, set heartbeat.target="none" to suppress delivery, or remove the heartbeat.session field to fall back to the agent main session.`
		].join("\n"));
	}
	return warnings;
}
//#endregion
//#region src/commands/doctor-session-state-providers.ts
function countLabel$1(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
function normalizeString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeIdSet(values) {
	return new Set((values ?? []).map((value) => normalizeProviderId(value)));
}
function normalizePrefixList(values) {
	return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}
function ownsPrefixedValue(prefixes, value) {
	const normalized = normalizeString(value)?.toLowerCase();
	return normalized !== void 0 && prefixes.some((prefix) => normalized.startsWith(prefix));
}
function countSessionLabel(count) {
	return countLabel$1(count, "session");
}
function repairExample(repair) {
	return `${repair.key} (${repair.reasons.join(", ")})`;
}
function resolveSessionAgentId(cfg, sessionKey) {
	return parseAgentSessionKey(sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
}
function resolveConfiguredDoctorSessionStateRoute(params) {
	const agentId = resolveSessionAgentId(params.cfg, params.sessionKey);
	const primary = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId
	});
	const configuredModelRefs = /* @__PURE__ */ new Set();
	const addRef = (provider, model) => {
		configuredModelRefs.add(modelKey(provider, model));
	};
	addRef(primary.provider, primary.model);
	const fallbacks = resolveAgentModelFallbacksOverride(params.cfg, agentId) ?? resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
	for (const fallback of fallbacks) {
		const parsed = parseModelRef(fallback, primary.provider, { allowPluginNormalization: false });
		if (parsed) addRef(parsed.provider, parsed.model);
	}
	const runtime = resolveAgentHarnessPolicy({
		provider: primary.provider,
		modelId: primary.model,
		config: params.cfg,
		agentId,
		sessionKey: params.sessionKey
	}).runtime;
	return {
		defaultProvider: primary.provider,
		configuredModelRefs: [...configuredModelRefs],
		runtime
	};
}
function resolvePluginDoctorSessionRouteStateOwners(params) {
	return listPluginDoctorSessionRouteStateOwners({
		config: params.cfg,
		env: params.env
	});
}
function entryMayContainPluginSessionRouteState(entry) {
	const record = entry;
	return normalizeString(record.providerOverride) !== void 0 || normalizeString(record.modelOverride) !== void 0 || normalizeString(record.modelOverrideSource) !== void 0 || record.liveModelSwitchPending !== void 0 || normalizeString(record.modelProvider) !== void 0 || normalizeString(record.model) !== void 0 || normalizeString(record.agentHarnessId) !== void 0 || normalizeString(record.agentRuntimeOverride) !== void 0 || record.cliSessionBindings !== void 0 || record.cliSessionIds !== void 0 || normalizeString(record.authProfileOverride) !== void 0 || normalizeString(record.authProfileOverrideSource) !== void 0;
}
function storeMayContainPluginSessionRouteState(store) {
	return Object.values(store).some((entry) => entryMayContainPluginSessionRouteState(entry));
}
function resolvePersistedOverrideModelRef(params) {
	const overrideModel = normalizeString(params.overrideModel);
	if (!overrideModel) return null;
	const overrideProvider = normalizeString(params.overrideProvider);
	return parseModelRef(overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel, params.defaultProvider, { allowPluginNormalization: false });
}
function addReason(reasons, reason) {
	if (!reasons.includes(reason)) reasons.push(reason);
}
function routeAllowsOwnerState(params) {
	const providerIds = normalizeIdSet(params.owner.providerIds);
	const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
	const routeRuntime = normalizeString(params.route?.runtime);
	if (routeRuntime && runtimeIds.has(normalizeProviderId(routeRuntime))) return true;
	return params.route?.configuredModelRefs.some((ref) => {
		const slash = ref.indexOf("/");
		return slash > 0 && providerIds.has(normalizeProviderId(ref.slice(0, slash)));
	}) ?? false;
}
function hasOwnedCliSession(params) {
	const bindings = params.entry.cliSessionBindings;
	const ids = params.entry.cliSessionIds;
	return params.cliSessionKeys.some((key) => {
		const normalized = normalizeProviderId(key);
		return bindings !== null && typeof bindings === "object" && normalized in bindings && bindings[normalized] !== void 0 || ids !== null && typeof ids === "object" && normalized in ids && ids[normalized] !== void 0;
	});
}
function modelRefKey(provider, model) {
	return modelKey(provider, model).toLowerCase();
}
function scanEntryForOwner(params) {
	const providerIds = normalizeIdSet(params.owner.providerIds);
	const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
	const cliSessionKeys = [...normalizeIdSet(params.owner.cliSessionKeys)];
	const authProfilePrefixes = normalizePrefixList(params.owner.authProfilePrefixes);
	const routeAllowsOwner = routeAllowsOwnerState({
		owner: params.owner,
		route: params.route
	});
	const routeRuntime = normalizeString(params.route?.runtime);
	const routeAllowsOwnerRuntime = routeRuntime !== void 0 && runtimeIds.has(normalizeProviderId(routeRuntime));
	const reasons = [];
	const pinnedRuntimeKeys = [];
	const directOverride = resolvePersistedOverrideModelRef({
		defaultProvider: params.route?.defaultProvider ?? "",
		overrideProvider: params.entry.providerOverride,
		overrideModel: params.entry.modelOverride
	});
	const directOverrideKey = directOverride ? modelRefKey(directOverride.provider, directOverride.model) : void 0;
	const directOverrideIsOwned = directOverride !== null && providerIds.has(normalizeProviderId(directOverride.provider));
	const directOverrideIsConfigured = directOverrideKey !== void 0 && (params.route?.configuredModelRefs.some((ref) => ref.toLowerCase() === directOverrideKey) ?? false);
	const directOverrideSource = params.entry.modelOverrideSource === "user" ? "user" : params.entry.modelOverrideSource === "auto" ? "auto" : params.entry.modelOverride ? "legacy" : void 0;
	if (directOverrideIsOwned && !directOverrideIsConfigured) {
		if (directOverrideSource === "auto") addReason(reasons, "auto model override");
		else if (!routeAllowsOwner && directOverride) return { manualReview: {
			key: params.key,
			ownerLabel: params.owner.label,
			message: `${params.key} (${modelRefKey(directOverride.provider, directOverride.model)}, ${directOverrideSource === "user" ? "user" : "legacy"})`
		} };
	}
	const explicitOwnedOverride = directOverrideIsOwned && directOverrideSource !== void 0 && directOverrideSource !== "auto";
	if (!routeAllowsOwnerRuntime && !explicitOwnedOverride) {
		const harnessId = normalizeString(params.entry.agentHarnessId);
		if (harnessId && runtimeIds.has(normalizeProviderId(harnessId))) {
			addReason(reasons, "pinned runtime");
			pinnedRuntimeKeys.push("agentHarnessId");
		}
		const runtimeOverride = normalizeString(params.entry.agentRuntimeOverride);
		if (runtimeOverride && runtimeIds.has(normalizeProviderId(runtimeOverride))) {
			addReason(reasons, "pinned runtime");
			pinnedRuntimeKeys.push("agentRuntimeOverride");
		}
	}
	if (!routeAllowsOwner && !explicitOwnedOverride) {
		const runtimeModel = normalizeString(params.entry.model);
		const runtimeRef = runtimeModel ? parseModelRef(runtimeModel, normalizeString(params.entry.modelProvider) ?? "", { allowPluginNormalization: false }) : null;
		if (runtimeRef && providerIds.has(normalizeProviderId(runtimeRef.provider))) addReason(reasons, "runtime model state");
		if (hasOwnedCliSession({
			entry: params.entry,
			cliSessionKeys
		})) addReason(reasons, "CLI session binding");
		if (params.entry.authProfileOverrideSource === "auto" && ownsPrefixedValue(authProfilePrefixes, params.entry.authProfileOverride)) addReason(reasons, "auto auth profile override");
	}
	if (reasons.length === 0) return {};
	return { repair: {
		key: params.key,
		ownerId: params.owner.id,
		ownerLabel: params.owner.label,
		reasons,
		pinnedRuntimeKeys,
		cliSessionKeys
	} };
}
function scanSessionRouteStateOwners(params) {
	const repairs = [];
	const manualReview = [];
	for (const [key, entry] of Object.entries(params.store)) {
		if (!entry || typeof entry !== "object") continue;
		for (const owner of params.owners) {
			const scan = scanEntryForOwner({
				key,
				entry,
				owner,
				route: params.routes[key]
			});
			if (scan.repair) repairs.push(scan.repair);
			if (scan.manualReview) manualReview.push(scan.manualReview);
		}
	}
	return {
		repairs,
		manualReview
	};
}
function clearEntryKey(entry, key) {
	if (entry[key] !== void 0) {
		delete entry[key];
		return true;
	}
	return false;
}
function clearRecordKeys(entry, recordKey, ownedKeys) {
	const value = entry[recordKey];
	if (value === null || typeof value !== "object") return false;
	const record = value;
	let changed = false;
	const next = { ...record };
	for (const key of ownedKeys) {
		const normalized = normalizeProviderId(key);
		if (next[normalized] !== void 0) {
			delete next[normalized];
			changed = true;
		}
	}
	if (!changed) return false;
	entry[recordKey] = Object.keys(next).length > 0 ? next : void 0;
	return true;
}
function applySessionRouteStateRepair(params) {
	let changed = false;
	const clear = (key) => {
		changed = clearEntryKey(params.entry, key) || changed;
	};
	if (params.repair.reasons.includes("auto model override")) {
		clear("providerOverride");
		clear("modelOverride");
		clear("modelOverrideSource");
		clear("liveModelSwitchPending");
	}
	if (params.repair.reasons.includes("runtime model state")) {
		clear("model");
		clear("modelProvider");
		clear("contextTokens");
		clear("systemPromptReport");
		clear("fallbackNoticeSelectedModel");
		clear("fallbackNoticeActiveModel");
		clear("fallbackNoticeReason");
	}
	if (params.repair.reasons.includes("pinned runtime")) for (const key of params.repair.pinnedRuntimeKeys) clear(key);
	if (params.repair.reasons.includes("CLI session binding")) {
		changed = clearRecordKeys(params.entry, "cliSessionBindings", params.repair.cliSessionKeys) || changed;
		changed = clearRecordKeys(params.entry, "cliSessionIds", params.repair.cliSessionKeys) || changed;
	}
	if (params.repair.reasons.includes("auto auth profile override")) {
		clear("authProfileOverride");
		clear("authProfileOverrideSource");
		clear("authProfileOverrideCompactionCount");
	}
	if (changed) params.entry.updatedAt = params.now;
	return changed;
}
function groupRepairsByOwner(repairs) {
	const grouped = /* @__PURE__ */ new Map();
	for (const repair of repairs) {
		const key = repair.ownerLabel;
		grouped.set(key, [...grouped.get(key) ?? [], repair]);
	}
	return grouped;
}
async function runPluginSessionStateDoctorRepairs(params) {
	if (!storeMayContainPluginSessionRouteState(params.store)) return;
	const owners = resolvePluginDoctorSessionRouteStateOwners({
		cfg: params.cfg,
		env: params.env
	});
	if (owners.length === 0) return;
	const routes = Object.fromEntries(Object.keys(params.store).map((sessionKey) => [sessionKey, resolveConfiguredDoctorSessionStateRoute({
		cfg: params.cfg,
		sessionKey,
		env: params.env
	})]));
	const store = params.store;
	const scan = scanSessionRouteStateOwners({
		owners,
		store,
		routes
	});
	if (scan.repairs.length > 0) for (const [ownerLabel, repairs] of groupRepairsByOwner(scan.repairs)) {
		const staleCount = countSessionLabel(repairs.length);
		params.warnings.push([
			`- Found stale ${ownerLabel} session routing state in ${staleCount} outside the current configured model/runtime route.`,
			"  This can keep later message-channel runs pinned to an old runtime/provider after defaults move elsewhere.",
			`  Examples: ${repairs.slice(0, 3).map(repairExample).join(", ")}`
		].join("\n"));
		if (await params.prompter.confirmRuntimeRepair({
			message: `Clear stale ${ownerLabel} session routing state for ${staleCount}?`,
			initialValue: true
		})) {
			let repaired = 0;
			const repairedAt = Date.now();
			const repairsByKey = new Map(repairs.map((repair) => [repair.key, repair]));
			await updateSessionStore(params.absoluteStorePath, (currentStore) => {
				const currentMutableStore = currentStore;
				for (const [key, repair] of repairsByKey) {
					const current = currentMutableStore[key];
					if (current && applySessionRouteStateRepair({
						entry: current,
						repair,
						now: repairedAt
					})) repaired += 1;
				}
			});
			if (repaired > 0) params.changes.push(`- Cleared stale ${ownerLabel} session routing state for ${countSessionLabel(repaired)}.`);
		}
	}
	if (scan.manualReview.length > 0) {
		const grouped = /* @__PURE__ */ new Map();
		for (const hit of scan.manualReview) grouped.set(hit.ownerLabel, [...grouped.get(hit.ownerLabel) ?? [], hit]);
		for (const [ownerLabel, hits] of grouped) params.warnings.push([
			`- Found explicit ${ownerLabel} model overrides in ${countSessionLabel(hits.length)} outside the current configured route.`,
			"  Doctor leaves explicit or legacy user selections untouched; switch them with /model or reset the session if that provider is no longer intended.",
			`  Examples: ${hits.slice(0, 3).map((hit) => hit.message).join(", ")}`
		].join("\n"));
	}
}
//#endregion
//#region src/commands/doctor-state-integrity.ts
function countLabel(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
function formatFilePreview(paths, limit = 3) {
	const names = paths.slice(0, limit).map((filePath) => path.basename(filePath));
	const remaining = paths.length - names.length;
	if (remaining > 0) return `${names.join(", ")}, and ${remaining} more`;
	return names.join(", ");
}
function existsDir(dir) {
	try {
		return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
function existsFile(filePath) {
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function tryResolveNativeRealPath(targetPath) {
	try {
		return fs.realpathSync.native(targetPath);
	} catch {
		return null;
	}
}
function resolveComparableTranscriptPath(filePath) {
	return tryResolveNativeRealPath(filePath) ?? path.resolve(filePath);
}
function areComparablePathsEqual(leftPath, rightPath) {
	const leftRealPath = tryResolveNativeRealPath(leftPath);
	const rightRealPath = tryResolveNativeRealPath(rightPath);
	return leftRealPath !== null && leftRealPath === rightRealPath;
}
function isReachableConfiguredAgentDir(params) {
	if (params.dirName === params.agentId) return true;
	const rawDir = path.join(params.agentsRoot, params.dirName, "agent");
	const normalizedDir = path.join(params.agentsRoot, params.agentId, "agent");
	const rawRealPath = tryResolveNativeRealPath(rawDir);
	const normalizedRealPath = tryResolveNativeRealPath(normalizedDir);
	return rawRealPath !== null && rawRealPath === normalizedRealPath;
}
function formatOrphanAgentDirLabel(entry) {
	return entry.dirName === entry.agentId ? entry.agentId : `${entry.dirName} (id ${entry.agentId})`;
}
function formatOrphanAgentDirPreview(entries, limit = 3) {
	const labels = entries.slice(0, limit).map(formatOrphanAgentDirLabel);
	const remaining = entries.length - labels.length;
	if (remaining > 0) return `${labels.join(", ")}, and ${remaining} more`;
	return labels.join(", ");
}
function listOrphanAgentDirs(cfg, stateDir) {
	const configuredIds = /* @__PURE__ */ new Set();
	configuredIds.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
	for (const entry of listAgentEntries(cfg)) configuredIds.add(normalizeAgentId(entry.id));
	const agentsRoot = path.join(stateDir, "agents");
	const liveCompatibilityAgentDir = resolveOpenClawAgentDir();
	try {
		return fs.readdirSync(agentsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({
			dirName: entry.name,
			agentId: normalizeAgentId(entry.name)
		})).filter(({ dirName, agentId }) => {
			const nestedAgentDir = path.join(agentsRoot, dirName, "agent");
			if (!existsDir(nestedAgentDir)) return false;
			if (areComparablePathsEqual(nestedAgentDir, liveCompatibilityAgentDir)) return false;
			if (!configuredIds.has(agentId)) return true;
			return !isReachableConfiguredAgentDir({
				agentsRoot,
				dirName,
				agentId
			});
		}).toSorted((left, right) => left.agentId.localeCompare(right.agentId) || left.dirName.localeCompare(right.dirName));
	} catch {
		return [];
	}
}
function canWriteDir(dir) {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
function dirPermissionHint(dir) {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const gid = typeof process.getgid === "function" ? process.getgid() : null;
	try {
		const stat = fs.statSync(dir);
		if (uid !== null && stat.uid !== uid) return `Owner mismatch (uid ${stat.uid}). Run: sudo chown -R $USER "${dir}"`;
		if (gid !== null && stat.gid !== gid) return `Group mismatch (gid ${stat.gid}). If access fails, run: sudo chown -R $USER "${dir}"`;
	} catch {
		return null;
	}
	return null;
}
function addUserRwx(mode) {
	return mode & 511 | 448;
}
function countJsonlLines(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		if (!raw) return 0;
		let count = 0;
		for (let i = 0; i < raw.length; i += 1) if (raw[i] === "\n") count += 1;
		if (!raw.endsWith("\n")) count += 1;
		return count;
	} catch {
		return 0;
	}
}
function findOtherStateDirs(stateDir) {
	const resolvedState = path.resolve(stateDir);
	const roots = process.platform === "darwin" ? ["/Users"] : process.platform === "linux" ? ["/home"] : [];
	const found = [];
	for (const root of roots) {
		let entries = [];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			const candidates = [".openclaw"].map((dir) => path.resolve(root, entry.name, dir));
			for (const candidate of candidates) {
				if (candidate === resolvedState) continue;
				if (existsDir(candidate)) found.push(candidate);
			}
		}
	}
	return found;
}
function isPathUnderRoot(targetPath, rootPath) {
	const normalizedTarget = path.resolve(targetPath);
	const normalizedRoot = path.resolve(rootPath);
	const rootToken = path.parse(normalizedRoot).root;
	if (normalizedRoot === rootToken) return normalizedTarget.startsWith(rootToken);
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}
function tryResolveRealPath(targetPath) {
	try {
		return fs.realpathSync(targetPath);
	} catch {
		return null;
	}
}
function decodeMountInfoPath(value) {
	return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function escapeControlCharsForTerminal(value) {
	let escaped = "";
	for (const char of value) {
		if (char === "\x1B") {
			escaped += "\\x1b";
			continue;
		}
		if (char === "\r") {
			escaped += "\\r";
			continue;
		}
		if (char === "\n") {
			escaped += "\\n";
			continue;
		}
		if (char === "	") {
			escaped += "\\t";
			continue;
		}
		const code = char.charCodeAt(0);
		if (code >= 0 && code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31) {
			escaped += `\\x${code.toString(16).padStart(2, "0")}`;
			continue;
		}
		if (code === 127) {
			escaped += "\\x7f";
			continue;
		}
		escaped += char;
	}
	return escaped;
}
function parseLinuxMountInfo(rawMountInfo) {
	const entries = [];
	for (const line of rawMountInfo.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const separatorIndex = trimmed.indexOf(" - ");
		if (separatorIndex === -1) continue;
		const left = trimmed.slice(0, separatorIndex);
		const right = trimmed.slice(separatorIndex + 3);
		const leftFields = left.split(" ");
		const rightFields = right.split(" ");
		if (leftFields.length < 5 || rightFields.length < 2) continue;
		entries.push({
			mountPoint: decodeMountInfoPath(leftFields[4]),
			fsType: rightFields[0],
			source: decodeMountInfoPath(rightFields[1])
		});
	}
	return entries;
}
function isPathUnderRootWithPathOps(targetPath, rootPath, pathOps) {
	const normalizedTarget = pathOps.resolve(targetPath);
	const normalizedRoot = pathOps.resolve(rootPath);
	const rootToken = pathOps.parse(normalizedRoot).root;
	if (normalizedRoot === rootToken) return normalizedTarget.startsWith(rootToken);
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${pathOps.sep}`);
}
function findLinuxMountInfoEntryForPath(targetPath, entries, pathOps) {
	const normalizedTarget = pathOps.resolve(targetPath);
	let bestMatch = null;
	for (const entry of entries) {
		if (!isPathUnderRootWithPathOps(normalizedTarget, entry.mountPoint, pathOps)) continue;
		if (!bestMatch || pathOps.resolve(entry.mountPoint).length > pathOps.resolve(bestMatch.mountPoint).length) bestMatch = entry;
	}
	return bestMatch;
}
function isMmcDevicePath(devicePath, pathOps) {
	const name = pathOps.basename(devicePath);
	return /^mmcblk\d+(?:p\d+)?$/.test(name);
}
function tryReadLinuxMountInfo() {
	try {
		return fs.readFileSync("/proc/self/mountinfo", "utf8");
	} catch {
		return null;
	}
}
function detectLinuxSdBackedStateDir(stateDir, deps) {
	if ((deps?.platform ?? process.platform) !== "linux") return null;
	const linuxPath = path.posix;
	const resolvedStatePath = (deps?.resolveRealPath ?? tryResolveRealPath)(stateDir) ?? linuxPath.resolve(stateDir);
	const mountInfo = deps?.mountInfo ?? tryReadLinuxMountInfo();
	if (!mountInfo) return null;
	const mountEntry = findLinuxMountInfoEntryForPath(resolvedStatePath, parseLinuxMountInfo(mountInfo), linuxPath);
	if (!mountEntry) return null;
	const sourceCandidates = [mountEntry.source];
	if (mountEntry.source.startsWith("/dev/")) {
		const resolvedDevicePath = (deps?.resolveDeviceRealPath ?? tryResolveRealPath)(mountEntry.source);
		if (resolvedDevicePath) sourceCandidates.push(linuxPath.resolve(resolvedDevicePath));
	}
	if (!sourceCandidates.some((candidate) => isMmcDevicePath(candidate, linuxPath))) return null;
	return {
		path: linuxPath.resolve(resolvedStatePath),
		mountPoint: linuxPath.resolve(mountEntry.mountPoint),
		fsType: mountEntry.fsType,
		source: mountEntry.source
	};
}
function formatLinuxSdBackedStateDirWarning(displayStateDir, linuxSdBackedStateDir) {
	const displayMountPoint = linuxSdBackedStateDir.mountPoint === "/" ? "/" : shortenHomePath(linuxSdBackedStateDir.mountPoint);
	return [
		`- State directory appears to be on SD/eMMC storage (${displayStateDir}; device ${escapeControlCharsForTerminal(linuxSdBackedStateDir.source)}, fs ${escapeControlCharsForTerminal(linuxSdBackedStateDir.fsType)}, mount ${escapeControlCharsForTerminal(displayMountPoint)}).`,
		"- SD/eMMC media can be slower for random I/O and wear faster under session/log churn.",
		"- For better startup and state durability, prefer SSD/NVMe (or USB SSD on Raspberry Pi) for OPENCLAW_STATE_DIR."
	].join("\n");
}
function detectMacCloudSyncedStateDir(stateDir, deps) {
	if ((deps?.platform ?? process.platform) !== "darwin") return null;
	const homedir = deps?.homedir ?? os.homedir();
	const roots = [{
		storage: "iCloud Drive",
		root: path.join(homedir, "Library", "Mobile Documents", "com~apple~CloudDocs")
	}, {
		storage: "CloudStorage provider",
		root: path.join(homedir, "Library", "CloudStorage")
	}];
	const realPath = (deps?.resolveRealPath ?? tryResolveRealPath)(stateDir);
	const candidates = realPath ? [path.resolve(realPath)] : [path.resolve(stateDir)];
	for (const candidate of candidates) for (const { storage, root } of roots) if (isPathUnderRoot(candidate, root)) return {
		path: candidate,
		storage
	};
	return null;
}
function isPairingPolicy(value) {
	return normalizeOptionalLowercaseString(value) === "pairing";
}
function hasPairingPolicy(value) {
	const record = asNullableObjectRecord(value);
	if (!record) return false;
	if (isPairingPolicy(record.dmPolicy)) return true;
	const dm = asNullableObjectRecord(record.dm);
	if (dm && isPairingPolicy(dm.policy)) return true;
	const accounts = asNullableObjectRecord(record.accounts);
	if (!accounts) return false;
	for (const accountCfg of Object.values(accounts)) if (hasPairingPolicy(accountCfg)) return true;
	return false;
}
function isSlashRoutingSessionKey(sessionKey) {
	const raw = normalizeOptionalLowercaseString(sessionKey);
	if (!raw) return false;
	const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
	return /^[^:]+:slash:[^:]+(?:$|:)/.test(scoped);
}
function shouldRequireOAuthDir(cfg, env) {
	if (env.OPENCLAW_OAUTH_DIR?.trim()) return true;
	const channels = asNullableObjectRecord(cfg.channels);
	if (!channels) return false;
	const withPersistedAuth = new Set(listConfiguredChannelIdsForReadOnlyScope({
		config: cfg,
		env
	}));
	const withoutPersistedAuth = new Set(listConfiguredChannelIdsForReadOnlyScope({
		config: cfg,
		env,
		includePersistedAuthState: false
	}));
	if ([...withPersistedAuth].some((channelId) => !withoutPersistedAuth.has(channelId))) return true;
	for (const [channelId, channelCfg] of Object.entries(channels)) {
		if (channelId === "defaults" || channelId === "modelByChannel") continue;
		if (hasPairingPolicy(channelCfg)) return true;
	}
	return false;
}
function shouldSuppressOrphanTranscriptWarning(cfg, agentId) {
	const backendConfig = resolveMemoryBackendConfig({
		cfg,
		agentId
	});
	return backendConfig?.backend === "qmd" && backendConfig.qmd?.sessions.enabled === true;
}
async function noteStateIntegrity(cfg, prompter, configPath) {
	const warnings = [];
	const changes = [];
	const noteFn = prompter.note ?? note;
	const env = process.env;
	const homedir = () => resolveRequiredHomeDir(env, os.homedir);
	const stateDir = resolveStateDir(env, homedir);
	const defaultStateDir = path.join(homedir(), ".openclaw");
	const oauthDir = resolveOAuthDir(env, stateDir);
	const agentId = resolveDefaultAgentId(cfg);
	const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, homedir);
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	const storeDir = path.dirname(storePath);
	const absoluteStorePath = path.resolve(storePath);
	const displayStateDir = shortenHomePath(stateDir);
	const displayOauthDir = shortenHomePath(oauthDir);
	const displaySessionsDir = shortenHomePath(sessionsDir);
	const displayStoreDir = shortenHomePath(storeDir);
	const displayConfigPath = configPath ? shortenHomePath(configPath) : void 0;
	const requireOAuthDir = shouldRequireOAuthDir(cfg, env);
	const cloudSyncedStateDir = detectMacCloudSyncedStateDir(stateDir);
	const linuxSdBackedStateDir = detectLinuxSdBackedStateDir(stateDir);
	const suppressOrphanTranscriptWarning = shouldSuppressOrphanTranscriptWarning(cfg, agentId);
	if (cloudSyncedStateDir) warnings.push([
		`- State directory is under macOS cloud-synced storage (${displayStateDir}; ${cloudSyncedStateDir.storage}).`,
		"- This can cause slow I/O and sync/lock races for sessions and credentials.",
		"- Prefer a local non-synced state dir (for example: ~/.openclaw).",
		`  Set locally: OPENCLAW_STATE_DIR=~/.openclaw ${formatCliCommand("openclaw doctor")}`
	].join("\n"));
	if (linuxSdBackedStateDir) warnings.push(formatLinuxSdBackedStateDirWarning(displayStateDir, linuxSdBackedStateDir));
	let stateDirExists = existsDir(stateDir);
	if (!stateDirExists) {
		warnings.push(`- CRITICAL: state directory missing (${displayStateDir}). Sessions, credentials, logs, and config are stored there.`);
		if (cfg.gateway?.mode === "remote") warnings.push("- Gateway is in remote mode; run doctor on the remote host where the gateway runs.");
		if (await prompter.confirmRuntimeRepair({
			message: `Create ${displayStateDir} now?`,
			initialValue: false
		})) {
			const created = ensureDir(stateDir);
			if (created.ok) {
				changes.push(`- Created ${displayStateDir}`);
				stateDirExists = true;
			} else warnings.push(`- Failed to create ${displayStateDir}: ${created.error}`);
		}
	}
	if (stateDirExists && !canWriteDir(stateDir)) {
		warnings.push(`- State directory not writable (${displayStateDir}).`);
		const hint = dirPermissionHint(stateDir);
		if (hint) warnings.push(`  ${hint}`);
		if (await prompter.confirmRuntimeRepair({
			message: `Repair permissions on ${displayStateDir}?`,
			initialValue: true
		})) try {
			const target = addUserRwx(fs.statSync(stateDir).mode);
			fs.chmodSync(stateDir, target);
			changes.push(`- Repaired permissions on ${displayStateDir}`);
		} catch (err) {
			warnings.push(`- Failed to repair ${displayStateDir}: ${String(err)}`);
		}
	}
	if (stateDirExists && process.platform !== "win32") try {
		const dirLstat = fs.lstatSync(stateDir);
		const isDirSymlink = dirLstat.isSymbolicLink();
		const stat = isDirSymlink ? fs.statSync(stateDir) : dirLstat;
		if (!(isDirSymlink ? fs.realpathSync(stateDir) : stateDir).startsWith("/nix/store/") && (stat.mode & 63) !== 0) {
			warnings.push(`- State directory permissions are too open (${displayStateDir}). Recommend chmod 700.`);
			if (await prompter.confirmRuntimeRepair({
				message: `Tighten permissions on ${displayStateDir} to 700?`,
				initialValue: true
			})) {
				fs.chmodSync(stateDir, 448);
				changes.push(`- Tightened permissions on ${displayStateDir} to 700`);
			}
		}
	} catch (err) {
		warnings.push(`- Failed to read ${displayStateDir} permissions: ${String(err)}`);
	}
	if (configPath && existsFile(configPath) && process.platform !== "win32") try {
		const configLstat = fs.lstatSync(configPath);
		const isSymlink = configLstat.isSymbolicLink();
		const stat = isSymlink ? fs.statSync(configPath) : configLstat;
		if (!(isSymlink ? fs.realpathSync(configPath) : configPath).startsWith("/nix/store/") && (stat.mode & 63) !== 0) {
			warnings.push(`- Config file is group/world readable (${displayConfigPath ?? configPath}). Recommend chmod 600.`);
			if (await prompter.confirmRuntimeRepair({
				message: `Tighten permissions on ${displayConfigPath ?? configPath} to 600?`,
				initialValue: true
			})) {
				fs.chmodSync(configPath, 384);
				changes.push(`- Tightened permissions on ${displayConfigPath ?? configPath} to 600`);
			}
		}
	} catch (err) {
		warnings.push(`- Failed to read config permissions (${displayConfigPath ?? configPath}): ${String(err)}`);
	}
	if (stateDirExists) {
		const dirCandidates = /* @__PURE__ */ new Map();
		dirCandidates.set(sessionsDir, "Sessions dir");
		dirCandidates.set(storeDir, "Session store dir");
		if (requireOAuthDir) dirCandidates.set(oauthDir, "OAuth dir");
		else if (!existsDir(oauthDir)) warnings.push(`- OAuth dir not present (${displayOauthDir}). Skipping create because no WhatsApp/pairing channel config is active.`);
		const displayDirFor = (dir) => {
			if (dir === sessionsDir) return displaySessionsDir;
			if (dir === storeDir) return displayStoreDir;
			if (dir === oauthDir) return displayOauthDir;
			return shortenHomePath(dir);
		};
		for (const [dir, label] of dirCandidates) {
			const displayDir = displayDirFor(dir);
			if (!existsDir(dir)) {
				warnings.push(`- CRITICAL: ${label} missing (${displayDir}).`);
				if (await prompter.confirmRuntimeRepair({
					message: `Create ${label} at ${displayDir}?`,
					initialValue: true
				})) {
					const created = ensureDir(dir);
					if (created.ok) changes.push(`- Created ${label}: ${displayDir}`);
					else warnings.push(`- Failed to create ${displayDir}: ${created.error}`);
				}
				continue;
			}
			if (!canWriteDir(dir)) {
				warnings.push(`- ${label} not writable (${displayDir}).`);
				const hint = dirPermissionHint(dir);
				if (hint) warnings.push(`  ${hint}`);
				if (await prompter.confirmRuntimeRepair({
					message: `Repair permissions on ${label}?`,
					initialValue: true
				})) try {
					const target = addUserRwx(fs.statSync(dir).mode);
					fs.chmodSync(dir, target);
					changes.push(`- Repaired permissions on ${label}: ${displayDir}`);
				} catch (err) {
					warnings.push(`- Failed to repair ${displayDir}: ${String(err)}`);
				}
			}
		}
	}
	const extraStateDirs = /* @__PURE__ */ new Set();
	if (path.resolve(stateDir) !== path.resolve(defaultStateDir)) {
		if (existsDir(defaultStateDir)) extraStateDirs.add(defaultStateDir);
	}
	for (const other of findOtherStateDirs(stateDir)) extraStateDirs.add(other);
	if (extraStateDirs.size > 0) warnings.push([
		"- Multiple state directories detected. This can split session history.",
		...Array.from(extraStateDirs).map((dir) => `  - ${shortenHomePath(dir)}`),
		`  Active state dir: ${displayStateDir}`
	].join("\n"));
	const orphanAgentDirs = listOrphanAgentDirs(cfg, stateDir);
	if (orphanAgentDirs.length > 0) warnings.push([
		`- Found ${countLabel(orphanAgentDirs.length, "agent directory", "agent directories")} on disk without a matching agents.list entry.`,
		"  These agents can still have sessions/auth state on disk, but config-driven routing, identity, and model selection will ignore them.",
		`  Examples: ${formatOrphanAgentDirPreview(orphanAgentDirs)}`,
		`  Restore the missing agents.list entries or remove stale dirs after confirming they are no longer needed: ${shortenHomePath(path.join(stateDir, "agents"))}`
	].join("\n"));
	const store = loadSessionStore(storePath);
	const sessionPathOpts = resolveSessionFilePathOptions({
		agentId,
		storePath
	});
	const entries = Object.entries(store).filter(([, entry]) => entry && typeof entry === "object");
	if (entries.length > 0) {
		const recentTranscriptCandidates = entries.slice().toSorted((a, b) => {
			const aUpdated = typeof a[1].updatedAt === "number" ? a[1].updatedAt : 0;
			return (typeof b[1].updatedAt === "number" ? b[1].updatedAt : 0) - aUpdated;
		}).slice(0, 5).filter(([key]) => !isSlashRoutingSessionKey(key));
		const missing = recentTranscriptCandidates.filter(([, entry]) => {
			const sessionId = entry.sessionId;
			if (!sessionId) return false;
			return !existsFile(resolveSessionFilePath(sessionId, entry, sessionPathOpts));
		});
		if (missing.length > 0) warnings.push([
			`- ${missing.length}/${recentTranscriptCandidates.length} recent sessions are missing transcripts.`,
			`  Verify sessions in store: ${formatCliCommand(`openclaw sessions --store "${absoluteStorePath}"`)}`,
			`  Preview cleanup impact: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --dry-run`)}`,
			`  Prune missing entries: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --enforce --fix-missing`)}`
		].join("\n"));
		const wedgedSubagentSessions = entries.filter(([, entry]) => isSubagentRecoveryWedgedEntry(entry));
		if (wedgedSubagentSessions.length > 0) {
			const wedgedCount = countLabel(wedgedSubagentSessions.length, "wedged subagent session");
			warnings.push([
				`- Found ${wedgedCount} with automatic restart recovery tombstoned.`,
				"  OpenClaw will not auto-resume these child sessions on restart; reconcile their task records instead.",
				`  Examples: ${wedgedSubagentSessions.slice(0, 3).map(([key]) => key).join(", ")}`,
				`  Fix: ${formatCliCommand("openclaw tasks maintenance --apply")}`
			].join("\n"));
			if (await prompter.confirmRuntimeRepair({
				message: `Clear stale aborted recovery flags for ${wedgedCount}?`,
				initialValue: true
			})) {
				let repaired = 0;
				const repairedAt = Date.now();
				await updateSessionStore(absoluteStorePath, (currentStore) => {
					for (const [key] of wedgedSubagentSessions) {
						const current = currentStore[key];
						if (current && clearWedgedSubagentRecoveryAbort(current, repairedAt)) {
							repaired += 1;
							currentStore[key] = current;
						}
					}
				});
				if (repaired > 0) changes.push(`- Cleared aborted restart-recovery flags for ${countLabel(repaired, "wedged subagent session")}.`);
			}
			const wedgedReasons = wedgedSubagentSessions.map(([, entry]) => formatSubagentRecoveryWedgedReason(entry)).filter((reason, index, all) => all.indexOf(reason) === index).slice(0, 2);
			if (wedgedReasons.length > 0) warnings.push(wedgedReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
		}
		await runPluginSessionStateDoctorRepairs({
			cfg,
			store,
			absoluteStorePath,
			prompter,
			env,
			warnings,
			changes
		});
		await repairHeartbeatPoisonedMainSession({
			cfg,
			store,
			absoluteStorePath,
			stateDir,
			sessionPathOpts,
			prompter,
			warnings,
			changes
		});
		for (const warning of describeHeartbeatSessionTargetIssues(cfg)) warnings.push(warning);
		const mainEntry = store[resolveMainSessionKey(cfg)];
		if (mainEntry?.sessionId) {
			const transcriptPath = resolveSessionFilePath(mainEntry.sessionId, mainEntry, sessionPathOpts);
			if (!existsFile(transcriptPath)) warnings.push(`- Main session transcript missing (${shortenHomePath(transcriptPath)}). History will appear to reset.`);
			else {
				const lineCount = countJsonlLines(transcriptPath);
				if (lineCount <= 1) warnings.push(`- Main session transcript has only ${lineCount} line. Session history may not be appending.`);
			}
		}
	}
	if (existsDir(sessionsDir)) {
		const referencedTranscriptPaths = /* @__PURE__ */ new Set();
		for (const [, entry] of entries) {
			if (!entry?.sessionId) continue;
			try {
				referencedTranscriptPaths.add(resolveComparableTranscriptPath(resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts)));
			} catch {}
		}
		const orphanTranscriptPaths = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && isPrimarySessionTranscriptFileName(entry.name)).map((entry) => path.join(sessionsDir, entry.name)).filter((filePath) => !referencedTranscriptPaths.has(resolveComparableTranscriptPath(filePath)));
		if (orphanTranscriptPaths.length > 0 && !suppressOrphanTranscriptWarning) {
			const orphanCount = countLabel(orphanTranscriptPaths.length, "orphan transcript file");
			const orphanPreview = formatFilePreview(orphanTranscriptPaths);
			warnings.push([
				`- Found ${orphanCount} in ${displaySessionsDir}.`,
				"  These .jsonl files are no longer referenced by sessions.json, so they are not part of any active session history.",
				"  Doctor can archive them safely by renaming each file to *.deleted.<timestamp>.",
				`  Examples: ${orphanPreview}`
			].join("\n"));
			if (await prompter.confirmRuntimeRepair({
				message: `Archive ${orphanCount} in ${displaySessionsDir}? This only renames them to *.deleted.<timestamp>.`,
				initialValue: false,
				requiresInteractiveConfirmation: true
			})) {
				let archived = 0;
				const archivedAt = formatSessionArchiveTimestamp();
				for (const orphanPath of orphanTranscriptPaths) {
					const archivedPath = `${orphanPath}.deleted.${archivedAt}`;
					try {
						fs.renameSync(orphanPath, archivedPath);
						archived += 1;
					} catch (err) {
						warnings.push(`- Failed to archive orphan transcript ${shortenHomePath(orphanPath)}: ${String(err)}`);
					}
				}
				if (archived > 0) changes.push(`- Archived ${countLabel(archived, "orphan transcript file")} in ${displaySessionsDir} as .deleted timestamped backups.`);
			}
		}
	}
	if (warnings.length > 0) noteFn(warnings.join("\n"), "State integrity");
	if (changes.length > 0) noteFn(changes.join("\n"), "Doctor changes");
}
function collectWorkspaceBackupTip(workspaceDir) {
	if (!existsDir(workspaceDir)) return null;
	const gitMarker = path.join(workspaceDir, ".git");
	if (fs.existsSync(gitMarker)) return null;
	return [
		"- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
		"- Keep ~/.openclaw out of git; it contains credentials and session history.",
		"- Details: /concepts/agent-workspace#git-backup-recommended"
	].join("\n");
}
function noteWorkspaceBackupTip(workspaceDir) {
	const tip = collectWorkspaceBackupTip(workspaceDir);
	if (tip) note(tip, "Workspace");
}
//#endregion
export { collectWorkspaceBackupTip, noteStateIntegrity, noteWorkspaceBackupTip };
