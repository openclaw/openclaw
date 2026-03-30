import { sn as DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "./auth-profiles-D6H-HVV8.js";
import { i as resolveAgentConfig } from "./agent-scope-C2k6BQnt.js";
import { T as resolveThreadParentSessionKey, l as resolveAgentIdFromSessionKey, s as normalizeAgentId } from "./session-key-qmb11-mH.js";
import { l as normalizeStringEntries, o as resolveChannelGroupToolsPolicy, t as getChannelDock } from "./dock-B6idJaIX.js";
import { l as normalizeMessageChannel } from "./message-channel-CJUwnCYd.js";
import { S as normalizeToolName, T as matchesAnyGlobPattern, w as compileGlobPatterns, x as expandToolGroups } from "./sandbox-COrmfGkR.js";
import { i as readChannelAllowFromStore } from "./pairing-store-CjsmzisR.js";
import { i as resolveGroupAllowFromSources, r as mergeDmAllowFromSources } from "./allow-from-DHIZx7da.js";

//#region src/channels/command-gating.ts
function resolveCommandAuthorizedFromAuthorizers(params) {
	const { useAccessGroups, authorizers } = params;
	const mode = params.modeWhenAccessGroupsOff ?? "allow";
	if (!useAccessGroups) {
		if (mode === "allow") return true;
		if (mode === "deny") return false;
		if (!authorizers.some((entry) => entry.configured)) return true;
		return authorizers.some((entry) => entry.configured && entry.allowed);
	}
	return authorizers.some((entry) => entry.configured && entry.allowed);
}
function resolveControlCommandGate(params) {
	const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers: params.authorizers,
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	});
	return {
		commandAuthorized,
		shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized
	};
}

//#endregion
//#region src/security/dm-policy-shared.ts
function resolveEffectiveAllowFromLists(params) {
	const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : void 0;
	const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : void 0;
	return {
		effectiveAllowFrom: normalizeStringEntries(mergeDmAllowFromSources({
			allowFrom,
			storeAllowFrom: Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : void 0,
			dmPolicy: params.dmPolicy ?? void 0
		})),
		effectiveGroupAllowFrom: normalizeStringEntries(resolveGroupAllowFromSources({
			allowFrom,
			groupAllowFrom,
			fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
		}))
	};
}
const DM_GROUP_ACCESS_REASON = {
	GROUP_POLICY_ALLOWED: "group_policy_allowed",
	GROUP_POLICY_DISABLED: "group_policy_disabled",
	GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
	GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
	DM_POLICY_OPEN: "dm_policy_open",
	DM_POLICY_DISABLED: "dm_policy_disabled",
	DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
	DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
	DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted"
};
async function readStoreAllowFromForDmPolicy(params) {
	if (params.shouldRead === false || params.dmPolicy === "allowlist") return [];
	return await (params.readStore ?? ((provider, accountId) => readChannelAllowFromStore(provider, process.env, accountId)))(params.provider, params.accountId).catch(() => []);
}
function resolveDmGroupAccessDecision(params) {
	const dmPolicy = params.dmPolicy ?? "pairing";
	const groupPolicy = params.groupPolicy ?? "allowlist";
	const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
	const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);
	if (params.isGroup) {
		if (groupPolicy === "disabled") return {
			decision: "block",
			reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
			reason: "groupPolicy=disabled"
		};
		if (groupPolicy === "allowlist") {
			if (effectiveGroupAllowFrom.length === 0) return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
				reason: "groupPolicy=allowlist (empty allowlist)"
			};
			if (!params.isSenderAllowed(effectiveGroupAllowFrom)) return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
				reason: "groupPolicy=allowlist (not allowlisted)"
			};
		}
		return {
			decision: "allow",
			reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
			reason: `groupPolicy=${groupPolicy}`
		};
	}
	if (dmPolicy === "disabled") return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED,
		reason: "dmPolicy=disabled"
	};
	if (dmPolicy === "open") return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN,
		reason: "dmPolicy=open"
	};
	if (params.isSenderAllowed(effectiveAllowFrom)) return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (allowlisted)`
	};
	if (dmPolicy === "pairing") return {
		decision: "pairing",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
		reason: "dmPolicy=pairing (not allowlisted)"
	};
	return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (not allowlisted)`
	};
}
function resolveDmGroupAccessWithLists(params) {
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		dmPolicy: params.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom
	});
	return {
		...resolveDmGroupAccessDecision({
			isGroup: params.isGroup,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy,
			effectiveAllowFrom,
			effectiveGroupAllowFrom,
			isSenderAllowed: params.isSenderAllowed
		}),
		effectiveAllowFrom,
		effectiveGroupAllowFrom
	};
}
function resolveDmGroupAccessWithCommandGate(params) {
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: params.groupPolicy,
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
		isSenderAllowed: params.isSenderAllowed
	});
	const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
	const configuredGroupAllowFrom = normalizeStringEntries(resolveGroupAllowFromSources({
		allowFrom: configuredAllowFrom,
		groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
		fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
	}));
	const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
	const commandGroupAllowFrom = params.isGroup ? configuredGroupAllowFrom : access.effectiveGroupAllowFrom;
	const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
	const commandGate = params.command ? resolveControlCommandGate({
		useAccessGroups: params.command.useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: ownerAllowedForCommands
		}, {
			configured: commandGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands: params.command.allowTextCommands,
		hasControlCommand: params.command.hasControlCommand
	}) : {
		commandAuthorized: false,
		shouldBlock: false
	};
	return {
		...access,
		commandAuthorized: commandGate.commandAuthorized,
		shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock
	};
}
async function resolveDmAllowState(params) {
	const configAllowFrom = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : void 0);
	const hasWildcard = configAllowFrom.includes("*");
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: params.provider,
		accountId: params.accountId,
		readStore: params.readStore
	});
	const normalizeEntry = params.normalizeEntry ?? ((value) => value);
	const normalizedCfg = configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const normalizedStore = storeAllowFrom.map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
	return {
		configAllowFrom,
		hasWildcard,
		allowCount,
		isMultiUserDm: hasWildcard || allowCount > 1
	};
}

//#endregion
//#region src/agents/sandbox-tool-policy.ts
function unionAllow(base, extra) {
	if (!Array.isArray(extra) || extra.length === 0) return base;
	if (!Array.isArray(base) || base.length === 0) return Array.from(new Set(["*", ...extra]));
	return Array.from(new Set([...base, ...extra]));
}
function pickSandboxToolPolicy(config) {
	if (!config) return;
	const allow = Array.isArray(config.allow) ? unionAllow(config.allow, config.alsoAllow) : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0 ? unionAllow(void 0, config.alsoAllow) : void 0;
	const deny = Array.isArray(config.deny) ? config.deny : void 0;
	if (!allow && !deny) return;
	return {
		allow,
		deny
	};
}

//#endregion
//#region src/agents/pi-tools.policy.ts
function makeToolPolicyMatcher(policy) {
	const deny = compileGlobPatterns({
		raw: expandToolGroups(policy.deny ?? []),
		normalize: normalizeToolName
	});
	const allow = compileGlobPatterns({
		raw: expandToolGroups(policy.allow ?? []),
		normalize: normalizeToolName
	});
	return (name) => {
		const normalized = normalizeToolName(name);
		if (matchesAnyGlobPattern(normalized, deny)) return false;
		if (allow.length === 0) return true;
		if (matchesAnyGlobPattern(normalized, allow)) return true;
		if (normalized === "apply_patch" && matchesAnyGlobPattern("exec", allow)) return true;
		return false;
	};
}
/**
* Tools always denied for sub-agents regardless of depth.
* These are system-level or interactive tools that sub-agents should never use.
*/
const SUBAGENT_TOOL_DENY_ALWAYS = [
	"gateway",
	"agents_list",
	"whatsapp_login",
	"session_status",
	"cron",
	"memory_search",
	"memory_get",
	"sessions_send"
];
/**
* Additional tools denied for leaf sub-agents (depth >= maxSpawnDepth).
* These are tools that only make sense for orchestrator sub-agents that can spawn children.
*/
const SUBAGENT_TOOL_DENY_LEAF = [
	"sessions_list",
	"sessions_history",
	"sessions_spawn"
];
/**
* Build the deny list for a sub-agent at a given depth.
*
* - Depth 1 with maxSpawnDepth >= 2 (orchestrator): allowed to use sessions_spawn,
*   subagents, sessions_list, sessions_history so it can manage its children.
* - Depth >= maxSpawnDepth (leaf): denied sessions_spawn and
*   session management tools. Still allowed subagents (for list/status visibility).
*/
function resolveSubagentDenyList(depth, maxSpawnDepth) {
	if (depth >= Math.max(1, Math.floor(maxSpawnDepth))) return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
	return [...SUBAGENT_TOOL_DENY_ALWAYS];
}
function resolveSubagentToolPolicy(cfg, depth) {
	const configured = cfg?.tools?.subagents?.tools;
	const maxSpawnDepth = cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
	const baseDeny = resolveSubagentDenyList(typeof depth === "number" && depth >= 0 ? depth : 1, maxSpawnDepth);
	const allow = Array.isArray(configured?.allow) ? configured.allow : void 0;
	const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : void 0;
	const explicitAllow = new Set([...allow ?? [], ...alsoAllow ?? []].map((toolName) => normalizeToolName(toolName)));
	const deny = [...baseDeny.filter((toolName) => !explicitAllow.has(normalizeToolName(toolName))), ...Array.isArray(configured?.deny) ? configured.deny : []];
	return {
		allow: allow && alsoAllow ? Array.from(new Set([...allow, ...alsoAllow])) : allow,
		deny
	};
}
function isToolAllowedByPolicyName(name, policy) {
	if (!policy) return true;
	return makeToolPolicyMatcher(policy)(name);
}
function filterToolsByPolicy(tools, policy) {
	if (!policy) return tools;
	const matcher = makeToolPolicyMatcher(policy);
	return tools.filter((tool) => matcher(tool.name));
}
function normalizeProviderKey(value) {
	return value.trim().toLowerCase();
}
function resolveGroupContextFromSessionKey(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return {};
	const parts = (resolveThreadParentSessionKey(raw) ?? raw).split(":").filter(Boolean);
	let body = parts[0] === "agent" ? parts.slice(2) : parts;
	if (body[0] === "subagent") body = body.slice(1);
	if (body.length < 3) return {};
	const [channel, kind, ...rest] = body;
	if (kind !== "group" && kind !== "channel") return {};
	const groupId = rest.join(":").trim();
	if (!groupId) return {};
	return {
		channel: channel.trim().toLowerCase(),
		groupId
	};
}
function resolveProviderToolPolicy(params) {
	const provider = params.modelProvider?.trim();
	if (!provider || !params.byProvider) return;
	const entries = Object.entries(params.byProvider);
	if (entries.length === 0) return;
	const lookup = /* @__PURE__ */ new Map();
	for (const [key, value] of entries) {
		const normalized = normalizeProviderKey(key);
		if (!normalized) continue;
		lookup.set(normalized, value);
	}
	const normalizedProvider = normalizeProviderKey(provider);
	const rawModelId = params.modelId?.trim().toLowerCase();
	const fullModelId = rawModelId && !rawModelId.includes("/") ? `${normalizedProvider}/${rawModelId}` : rawModelId;
	const candidates = [...fullModelId ? [fullModelId] : [], normalizedProvider];
	for (const key of candidates) {
		const match = lookup.get(key);
		if (match) return match;
	}
}
function resolveEffectiveToolPolicy(params) {
	const agentId = (typeof params.agentId === "string" && params.agentId.trim() ? normalizeAgentId(params.agentId) : void 0) ?? (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : void 0);
	const agentTools = (params.config && agentId ? resolveAgentConfig(params.config, agentId) : void 0)?.tools;
	const globalTools = params.config?.tools;
	const profile = agentTools?.profile ?? globalTools?.profile;
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
	return {
		agentId,
		globalPolicy: pickSandboxToolPolicy(globalTools),
		globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
		agentPolicy: pickSandboxToolPolicy(agentTools),
		agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
		profile,
		providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
		profileAlsoAllow: Array.isArray(agentTools?.alsoAllow) ? agentTools?.alsoAllow : Array.isArray(globalTools?.alsoAllow) ? globalTools?.alsoAllow : void 0,
		providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow) ? agentProviderPolicy?.alsoAllow : Array.isArray(providerPolicy?.alsoAllow) ? providerPolicy?.alsoAllow : void 0
	};
}
function resolveGroupToolPolicy(params) {
	if (!params.config) return;
	const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
	const spawnedContext = resolveGroupContextFromSessionKey(params.spawnedBy);
	const groupId = params.groupId ?? sessionContext.groupId ?? spawnedContext.groupId;
	if (!groupId) return;
	const channel = normalizeMessageChannel(params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel);
	if (!channel) return;
	let dock;
	try {
		dock = getChannelDock(channel);
	} catch {
		dock = void 0;
	}
	return pickSandboxToolPolicy(dock?.groups?.resolveToolPolicy?.({
		cfg: params.config,
		groupId,
		groupChannel: params.groupChannel,
		groupSpace: params.groupSpace,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	}) ?? resolveChannelGroupToolsPolicy({
		cfg: params.config,
		channel,
		groupId,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	}));
}
function isToolAllowedByPolicies(name, policies) {
	return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}

//#endregion
export { resolveSubagentToolPolicy as a, readStoreAllowFromForDmPolicy as c, resolveDmGroupAccessWithLists as d, resolveCommandAuthorizedFromAuthorizers as f, resolveGroupToolPolicy as i, resolveDmAllowState as l, isToolAllowedByPolicies as n, pickSandboxToolPolicy as o, resolveControlCommandGate as p, resolveEffectiveToolPolicy as r, DM_GROUP_ACCESS_REASON as s, filterToolsByPolicy as t, resolveDmGroupAccessWithCommandGate as u };