import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { l as parseRawSessionConversationRef, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import { t as resolveSessionConversation } from "./session-conversation-XHNnUnBT.js";
import "./plugins-DYTHbmt7.js";
import { r as resolveChannelGroupToolsPolicy } from "./group-policy-sKF5rlUN.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-A1J2EpRM.js";
import { h as resolveToolProfilePolicy, l as mergeAlsoAllowPolicy, m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { n as isToolAllowedByPolicyName } from "./tool-policy-match-C9WqMgmG.js";
import { i as resolveStoredSubagentInheritedToolDenylist, n as resolveStoredSubagentCapabilities, o as resolveSubagentCapabilityStore, r as resolveStoredSubagentInheritedToolAllowlist } from "./subagent-capabilities-mB73wM9t.js";
//#region src/agents/pi-tools.policy.ts
/**
* Tools always denied for sub-agents regardless of depth.
* These are system-level or interactive tools that sub-agents should never use.
*/
const SUBAGENT_TOOL_DENY_ALWAYS = [
	"gateway",
	"agents_list",
	"session_status",
	"cron",
	"sessions_send"
];
/**
* Additional tools denied for leaf sub-agents (depth >= maxSpawnDepth).
* These are tools that only make sense for orchestrator sub-agents that can spawn children.
*/
const SUBAGENT_TOOL_DENY_LEAF = [
	"subagents",
	"sessions_list",
	"sessions_history",
	"sessions_spawn"
];
function resolveSubagentDenyListForRole(role) {
	if (role === "leaf") return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
	return [...SUBAGENT_TOOL_DENY_ALWAYS];
}
function mergeConfiguredSubagentAllow(allow, alsoAllow) {
	return allow && alsoAllow ? Array.from(new Set([...allow, ...alsoAllow])) : allow;
}
function resolveSubagentToolPolicyForSession(cfg, sessionKey, opts) {
	const configured = cfg?.tools?.subagents?.tools;
	const capabilities = resolveStoredSubagentCapabilities(sessionKey, {
		cfg,
		store: resolveSubagentCapabilityStore(sessionKey, {
			cfg,
			store: opts?.store
		})
	});
	const allow = Array.isArray(configured?.allow) ? configured.allow : void 0;
	const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : void 0;
	const explicitAllow = new Set([...allow ?? [], ...alsoAllow ?? []].map((toolName) => normalizeToolName(toolName)));
	const deny = [...resolveSubagentDenyListForRole(capabilities.role).filter((toolName) => !explicitAllow.has(normalizeToolName(toolName))), ...Array.isArray(configured?.deny) ? configured.deny : []];
	return {
		allow: mergeConfiguredSubagentAllow(allow, alsoAllow),
		deny
	};
}
function resolveInheritedToolPolicyForSession(cfg, sessionKey, opts) {
	const inheritedToolAllow = resolveStoredSubagentInheritedToolAllowlist(sessionKey, {
		cfg,
		store: opts?.store
	});
	const inheritedToolDeny = resolveStoredSubagentInheritedToolDenylist(sessionKey, {
		cfg,
		store: opts?.store
	});
	if (inheritedToolAllow.length === 0 && inheritedToolDeny.length === 0) return;
	return {
		...inheritedToolAllow.length > 0 ? { allow: inheritedToolAllow } : {},
		...inheritedToolDeny.length > 0 ? { deny: inheritedToolDeny } : {}
	};
}
function filterToolsByPolicy(tools, policy) {
	if (!policy) return tools;
	return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}
function normalizeProviderKey(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	const slashIndex = normalized.indexOf("/");
	if (slashIndex <= 0) return normalizeProviderId(normalized);
	const provider = normalizeProviderId(normalized.slice(0, slashIndex));
	const modelId = normalized.slice(slashIndex + 1);
	return modelId ? `${provider}/${modelId}` : provider;
}
function isCanonicalProviderKey(value) {
	return normalizeLowercaseStringOrEmpty(value) === normalizeProviderKey(value);
}
function buildProviderToolPolicyLookup(entries) {
	const lookup = /* @__PURE__ */ new Map();
	for (const [key, value] of entries) {
		const normalized = normalizeProviderKey(key);
		if (!normalized) continue;
		const canonical = isCanonicalProviderKey(key);
		const existing = lookup.get(normalized);
		if (!existing || canonical && !existing.canonical) lookup.set(normalized, {
			canonical,
			value
		});
	}
	const resolved = /* @__PURE__ */ new Map();
	for (const [key, entry] of lookup) resolved.set(key, entry.value);
	return resolved;
}
function collectUniqueStrings(values) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		resolved.push(trimmed);
	}
	return resolved;
}
function buildScopedGroupIdCandidates(groupId) {
	const raw = groupId?.trim();
	if (!raw) return [];
	const topicSenderMatch = raw.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
	if (topicSenderMatch) {
		const [, chatId, topicId] = topicSenderMatch;
		return collectUniqueStrings([
			raw,
			`${chatId}:topic:${topicId}`,
			chatId
		]);
	}
	const topicMatch = raw.match(/^(.+):topic:([^:]+)$/i);
	if (topicMatch) {
		const [, chatId, topicId] = topicMatch;
		return collectUniqueStrings([`${chatId}:topic:${topicId}`, chatId]);
	}
	const senderMatch = raw.match(/^(.+):sender:([^:]+)$/i);
	if (senderMatch) {
		const [, chatId] = senderMatch;
		return collectUniqueStrings([raw, chatId]);
	}
	return [raw];
}
function resolveGroupContextFromSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return {};
	const { baseSessionKey, threadId } = parseThreadSessionSuffix(raw);
	const conversationKey = threadId ? baseSessionKey : raw;
	const conversation = parseRawSessionConversationRef(conversationKey);
	if (conversation) {
		const resolvedConversation = resolveSessionConversation({
			channel: conversation.channel,
			kind: conversation.kind,
			rawId: conversation.rawId
		});
		return {
			channel: conversation.channel,
			groupIds: collectUniqueStrings([
				...buildScopedGroupIdCandidates(conversation.rawId),
				resolvedConversation?.id,
				resolvedConversation?.baseConversationId,
				...resolvedConversation?.parentConversationCandidates ?? []
			])
		};
	}
	const parts = (conversationKey ?? raw).split(":").filter(Boolean);
	let body = parts[0] === "agent" ? parts.slice(2) : parts;
	if (body[0] === "subagent") body = body.slice(1);
	if (body.length < 3) return {};
	const [channel, kind, ...rest] = body;
	if (kind !== "group" && kind !== "channel") return {};
	const groupId = rest.join(":").trim();
	if (!groupId) return {};
	return {
		channel: normalizeLowercaseStringOrEmpty(channel),
		groupIds: buildScopedGroupIdCandidates(groupId)
	};
}
function resolveTrustedGroupIdFromContexts(params) {
	const callerGroupId = (params.groupId ?? "").trim();
	if (!callerGroupId) return {
		groupId: params.groupId,
		dropped: false
	};
	const trustedGroupIds = collectUniqueStrings([...params.sessionContext.groupIds ?? [], ...params.spawnedContext.groupIds ?? []]);
	if (trustedGroupIds.length === 0) return {
		groupId: null,
		dropped: true
	};
	if (trustedGroupIds.includes(callerGroupId)) return {
		groupId: params.groupId,
		dropped: false
	};
	return {
		groupId: null,
		dropped: true
	};
}
function resolveTrustedGroupId(params) {
	return resolveTrustedGroupIdFromContexts({
		groupId: params.groupId,
		sessionContext: resolveGroupContextFromSessionKey(params.sessionKey),
		spawnedContext: resolveGroupContextFromSessionKey(params.spawnedBy)
	});
}
function resolveProviderToolPolicy(params) {
	const provider = params.modelProvider?.trim();
	if (!provider || !params.byProvider) return;
	const entries = Object.entries(params.byProvider);
	if (entries.length === 0) return;
	const lookup = buildProviderToolPolicyLookup(entries);
	const normalizedProvider = normalizeProviderKey(provider);
	const rawModelId = normalizeOptionalLowercaseString(params.modelId);
	const fullModelId = rawModelId ? `${normalizedProvider}/${rawModelId}` : void 0;
	const candidates = [...fullModelId ? [fullModelId] : [], normalizedProvider];
	for (const key of candidates) {
		const match = lookup.get(key);
		if (match) return match;
	}
}
function resolveExplicitProfileAlsoAllow(tools) {
	return Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : void 0;
}
function hasExplicitToolSection(section) {
	return section !== void 0 && section !== null;
}
function detectImplicitProfileGrants(params) {
	const entries = [];
	if (hasExplicitToolSection(params.agentTools?.exec) || params.includeGlobalSections && hasExplicitToolSection(params.globalTools?.exec)) entries.push({
		section: "tools.exec",
		grants: ["exec", "process"]
	});
	if (hasExplicitToolSection(params.agentTools?.fs) || params.includeGlobalSections && hasExplicitToolSection(params.globalTools?.fs)) entries.push({
		section: "tools.fs",
		grants: [
			"read",
			"write",
			"edit"
		]
	});
	if (entries.length === 0) return;
	return { entries };
}
function formatImplicitToolSections(sections) {
	return sections.join(" / ");
}
function formatToolListForWarning(toolNames) {
	return toolNames.map((toolName) => `"${toolName}"`).join(", ");
}
function resolveEffectiveToolPolicy(params) {
	const agentId = (typeof params.agentId === "string" && params.agentId.trim() ? normalizeAgentId(params.agentId) : void 0) ?? (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : void 0);
	const agentTools = (params.config && agentId ? resolveAgentConfig(params.config, agentId) : void 0)?.tools;
	const globalTools = params.config?.tools;
	const profile = agentTools?.profile ?? globalTools?.profile;
	const profileSource = agentTools?.profile ? "agent" : globalTools?.profile ? "global" : void 0;
	const providerPolicy = resolveProviderToolPolicy({
		byProvider: globalTools?.byProvider,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	const agentProviderPolicy = resolveProviderToolPolicy({
		byProvider: agentTools?.byProvider,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	const explicitProfileAlsoAllow = resolveExplicitProfileAlsoAllow(agentTools) ?? resolveExplicitProfileAlsoAllow(globalTools);
	if (profile) {
		const implicitGrants = detectImplicitProfileGrants({
			globalTools,
			agentTools,
			includeGlobalSections: profileSource === "global"
		});
		if (implicitGrants) {
			const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), explicitProfileAlsoAllow);
			const uncoveredEntries = implicitGrants.entries.map((entry) => ({
				section: entry.section,
				grants: entry.grants.filter((toolName) => !isToolAllowedByPolicyName(toolName, profilePolicy))
			})).filter((entry) => entry.grants.length > 0);
			const uncovered = uncoveredEntries.flatMap((entry) => entry.grants);
			if (uncovered.length > 0) logWarn(`tools policy: profile "${profile}"${agentId ? ` (agent "${agentId}")` : ""} has configured tool sections (${formatImplicitToolSections(uncoveredEntries.map((entry) => entry.section))}) that no longer implicitly widen the profile. Add alsoAllow: [${formatToolListForWarning(uncovered)}] explicitly if these tools should be available. See #47487.`);
		}
	}
	const profileAlsoAllow = explicitProfileAlsoAllow ? Array.from(new Set(explicitProfileAlsoAllow)) : void 0;
	return {
		agentId,
		globalPolicy: pickSandboxToolPolicy(globalTools),
		globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
		agentPolicy: pickSandboxToolPolicy(agentTools),
		agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
		profile,
		providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
		profileAlsoAllow,
		providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow) ? agentProviderPolicy?.alsoAllow : Array.isArray(providerPolicy?.alsoAllow) ? providerPolicy?.alsoAllow : void 0
	};
}
function resolveGroupToolPolicy(params) {
	if (!params.config) return;
	const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
	const spawnedContext = resolveGroupContextFromSessionKey(params.spawnedBy);
	const trustedGroup = resolveTrustedGroupIdFromContexts({
		groupId: params.groupId,
		sessionContext,
		spawnedContext
	});
	const groupIds = collectUniqueStrings([
		...sessionContext.groupIds ?? [],
		...spawnedContext.groupIds ?? [],
		...buildScopedGroupIdCandidates(trustedGroup.groupId)
	]);
	if (groupIds.length === 0) return;
	const channel = normalizeMessageChannel(sessionContext.channel ?? spawnedContext.channel ?? params.messageProvider);
	if (!channel) return;
	let plugin;
	try {
		plugin = getLoadedChannelPlugin(channel);
	} catch {
		plugin = void 0;
	}
	for (const groupId of groupIds) {
		const toolsConfig = plugin?.groups?.resolveToolPolicy?.({
			cfg: params.config,
			groupId,
			groupChannel: trustedGroup.dropped ? null : params.groupChannel,
			groupSpace: trustedGroup.dropped ? null : params.groupSpace,
			accountId: params.accountId,
			senderId: params.senderId,
			senderName: params.senderName,
			senderUsername: params.senderUsername,
			senderE164: params.senderE164
		});
		const policy = pickSandboxToolPolicy(toolsConfig);
		if (policy) return policy;
	}
	return pickSandboxToolPolicy(resolveChannelGroupToolsPolicy({
		cfg: params.config,
		channel,
		messageProvider: channel,
		groupId: groupIds[0],
		groupIdCandidates: groupIds.slice(1),
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	}));
}
//#endregion
export { resolveProviderToolPolicy as a, resolveInheritedToolPolicyForSession as i, resolveEffectiveToolPolicy as n, resolveSubagentToolPolicyForSession as o, resolveGroupToolPolicy as r, resolveTrustedGroupId as s, filterToolsByPolicy as t };
