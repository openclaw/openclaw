import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { d as resolveAgentIdFromSessionKey, m as sanitizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as listConfiguredBindings } from "./bindings-D1F1bOgs.js";
import { r as pickFirstExistingAgentId } from "./resolve-route-C8IahAyG.js";
import { createHash } from "node:crypto";
//#region src/acp/persistent-bindings.types.ts
function normalizeMode(value) {
	return normalizeOptionalLowercaseString(value) === "oneshot" ? "oneshot" : "persistent";
}
function normalizeBindingConfig(raw) {
	if (!raw || typeof raw !== "object") return {};
	const shape = raw;
	const mode = normalizeOptionalString(shape.mode);
	return {
		mode: mode ? normalizeMode(mode) : void 0,
		cwd: normalizeOptionalString(shape.cwd),
		backend: normalizeOptionalString(shape.backend),
		label: normalizeOptionalString(shape.label)
	};
}
function buildBindingHash(params) {
	return createHash("sha256").update(`${params.channel}:${params.accountId}:${params.conversationId}`).digest("hex").slice(0, 16);
}
function buildConfiguredAcpSessionKey(spec) {
	const hash = buildBindingHash({
		channel: spec.channel,
		accountId: spec.accountId,
		conversationId: spec.conversationId
	});
	return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}
function toConfiguredAcpBindingRecord(spec) {
	return {
		bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
		targetSessionKey: buildConfiguredAcpSessionKey(spec),
		targetKind: "session",
		conversation: {
			channel: spec.channel,
			accountId: spec.accountId,
			conversationId: spec.conversationId,
			parentConversationId: spec.parentConversationId
		},
		status: "active",
		boundAt: 0,
		metadata: {
			source: "config",
			mode: spec.mode,
			agentId: spec.agentId,
			...spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {},
			label: spec.label,
			...spec.backend ? { backend: spec.backend } : {},
			...spec.cwd ? { cwd: spec.cwd } : {}
		}
	};
}
function parseConfiguredAcpSessionKey(sessionKey) {
	const trimmed = sessionKey.trim();
	if (!trimmed.startsWith("agent:")) return null;
	const rest = trimmed.slice(trimmed.indexOf(":") + 1);
	const nextSeparator = rest.indexOf(":");
	if (nextSeparator === -1) return null;
	const tokens = rest.slice(nextSeparator + 1).split(":");
	if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") return null;
	const channel = normalizeOptionalLowercaseString(tokens[2]);
	if (!channel) return null;
	return {
		channel,
		accountId: normalizeAccountId(tokens[3] ?? "default")
	};
}
function resolveConfiguredAcpBindingSpecFromRecord(record) {
	if (record.targetKind !== "session") return null;
	const conversationId = record.conversation.conversationId.trim();
	if (!conversationId) return null;
	const agentId = normalizeOptionalString(record.metadata?.agentId) ?? resolveAgentIdFromSessionKey(record.targetSessionKey);
	if (!agentId) return null;
	return {
		channel: record.conversation.channel,
		accountId: normalizeAccountId(record.conversation.accountId),
		conversationId,
		parentConversationId: normalizeOptionalString(record.conversation.parentConversationId),
		agentId,
		acpAgentId: normalizeOptionalString(record.metadata?.acpAgentId),
		mode: normalizeMode(record.metadata?.mode),
		cwd: normalizeOptionalString(record.metadata?.cwd),
		backend: normalizeOptionalString(record.metadata?.backend),
		label: normalizeOptionalString(record.metadata?.label)
	};
}
function toResolvedConfiguredAcpBinding(record) {
	const spec = resolveConfiguredAcpBindingSpecFromRecord(record);
	if (!spec) return null;
	return {
		spec,
		record
	};
}
//#endregion
//#region src/channels/plugins/acp-configured-binding-consumer.ts
function resolveAgentRuntimeAcpDefaults(params) {
	const ownerAgentId = normalizeLowercaseStringOrEmpty(params.ownerAgentId);
	const agent = params.cfg.agents?.list?.find((entry) => normalizeOptionalLowercaseString(entry.id) === ownerAgentId);
	if (!agent || agent.runtime?.type !== "acp") return {};
	return {
		acpAgentId: normalizeOptionalString(agent.runtime.acp?.agent),
		mode: normalizeOptionalString(agent.runtime.acp?.mode),
		cwd: normalizeOptionalString(agent.runtime.acp?.cwd),
		backend: normalizeOptionalString(agent.runtime.acp?.backend)
	};
}
function resolveConfiguredBindingWorkspaceCwd(params) {
	if (normalizeOptionalString(resolveAgentConfig(params.cfg, params.agentId)?.workspace)) return resolveAgentWorkspaceDir(params.cfg, params.agentId);
	if (params.agentId === resolveDefaultAgentId(params.cfg)) {
		if (normalizeOptionalString(params.cfg.agents?.defaults?.workspace)) return resolveAgentWorkspaceDir(params.cfg, params.agentId);
	}
}
function buildConfiguredAcpSpec(params) {
	return {
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversation.conversationId,
		parentConversationId: params.conversation.parentConversationId,
		agentId: params.agentId,
		acpAgentId: params.acpAgentId,
		mode: params.mode,
		cwd: params.cwd,
		backend: params.backend,
		label: params.label
	};
}
function buildAcpTargetFactory(params) {
	if (params.binding.type !== "acp") return null;
	const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
		cfg: params.cfg,
		ownerAgentId: params.agentId
	});
	const bindingOverrides = normalizeBindingConfig(params.binding.acp);
	const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
	const cwd = bindingOverrides.cwd ?? runtimeDefaults.cwd ?? resolveConfiguredBindingWorkspaceCwd({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const backend = bindingOverrides.backend ?? runtimeDefaults.backend;
	const label = bindingOverrides.label;
	const acpAgentId = normalizeOptionalString(runtimeDefaults.acpAgentId);
	return {
		driverId: "acp",
		materialize: ({ accountId, conversation }) => {
			const spec = buildConfiguredAcpSpec({
				channel: params.channel,
				accountId,
				conversation,
				agentId: params.agentId,
				acpAgentId,
				mode,
				cwd,
				backend,
				label
			});
			return {
				record: toConfiguredAcpBindingRecord(spec),
				statefulTarget: {
					kind: "stateful",
					driverId: "acp",
					sessionKey: buildConfiguredAcpSessionKey(spec),
					agentId: params.agentId,
					...label ? { label } : {}
				}
			};
		}
	};
}
const acpConfiguredBindingConsumer = {
	id: "acp",
	supports: (binding) => binding.type === "acp",
	buildTargetFactory: (params) => buildAcpTargetFactory({
		cfg: params.cfg,
		binding: params.binding,
		channel: params.channel,
		agentId: params.agentId
	}),
	parseSessionKey: ({ sessionKey }) => parseConfiguredAcpSessionKey(sessionKey),
	matchesSessionKey: ({ sessionKey, materializedTarget }) => materializedTarget.record.targetSessionKey === sessionKey
};
//#endregion
//#region src/channels/plugins/configured-binding-consumers.ts
const registeredConfiguredBindingConsumers = /* @__PURE__ */ new Map();
function listConfiguredBindingConsumers() {
	return [...registeredConfiguredBindingConsumers.values()];
}
function resolveConfiguredBindingConsumer(binding) {
	for (const consumer of listConfiguredBindingConsumers()) if (consumer.supports(binding)) return consumer;
	return null;
}
function registerConfiguredBindingConsumer(consumer) {
	const id = consumer.id.trim();
	if (!id) throw new Error("Configured binding consumer id is required");
	if (registeredConfiguredBindingConsumers.get(id)) return;
	registeredConfiguredBindingConsumers.set(id, {
		...consumer,
		id
	});
}
//#endregion
//#region src/channels/plugins/configured-binding-builtins.ts
function ensureConfiguredBindingBuiltinsRegistered() {
	registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
//#endregion
//#region src/channels/plugins/binding-provider.ts
function resolveChannelConfiguredBindingProvider(plugin) {
	return plugin?.bindings;
}
//#endregion
//#region src/channels/plugins/configured-binding-compiler.ts
function resolveLoadedChannelPlugin(channel) {
	const normalized = normalizeOptionalLowercaseString(channel);
	if (!normalized) return;
	return getChannelPlugin(normalized);
}
function resolveConfiguredBindingAdapter(channel) {
	const normalized = normalizeOptionalLowercaseString(channel);
	if (!normalized) return null;
	const plugin = resolveLoadedChannelPlugin(normalized);
	const provider = resolveChannelConfiguredBindingProvider(plugin);
	if (!plugin || !provider || !provider.compileConfiguredBinding || !provider.matchInboundConversation) return null;
	return {
		channel: plugin.id,
		provider
	};
}
function resolveBindingConversationId(binding) {
	return normalizeOptionalString(binding.match?.peer?.id) ?? null;
}
function compileConfiguredBindingTarget(params) {
	return params.provider.compileConfiguredBinding({
		binding: params.binding,
		conversationId: params.conversationId
	});
}
function compileConfiguredBindingRule(params) {
	const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
	const consumer = resolveConfiguredBindingConsumer(params.binding);
	if (!consumer) return null;
	const targetFactory = consumer.buildTargetFactory({
		cfg: params.cfg,
		binding: params.binding,
		channel: params.channel,
		agentId,
		target: params.target,
		bindingConversationId: params.bindingConversationId
	});
	if (!targetFactory) return null;
	return {
		channel: params.channel,
		accountPattern: normalizeOptionalString(params.binding.match.accountId),
		binding: params.binding,
		bindingConversationId: params.bindingConversationId,
		target: params.target,
		agentId,
		provider: params.provider,
		targetFactory
	};
}
function pushCompiledRule(target, rule) {
	const existing = target.get(rule.channel);
	if (existing) {
		existing.push(rule);
		return;
	}
	target.set(rule.channel, [rule]);
}
function compileConfiguredBindingRegistry(params) {
	const rulesByChannel = /* @__PURE__ */ new Map();
	for (const binding of listConfiguredBindings(params.cfg)) {
		const bindingConversationId = resolveBindingConversationId(binding);
		if (!bindingConversationId) continue;
		const resolvedChannel = resolveConfiguredBindingAdapter(binding.match.channel);
		if (!resolvedChannel) continue;
		const target = compileConfiguredBindingTarget({
			provider: resolvedChannel.provider,
			binding,
			conversationId: bindingConversationId
		});
		if (!target) continue;
		const rule = compileConfiguredBindingRule({
			cfg: params.cfg,
			channel: resolvedChannel.channel,
			binding,
			target,
			bindingConversationId,
			provider: resolvedChannel.provider
		});
		if (!rule) continue;
		pushCompiledRule(rulesByChannel, rule);
	}
	return { rulesByChannel };
}
function resolveCompiledBindingRegistry(cfg) {
	return compileConfiguredBindingRegistry({ cfg });
}
function primeCompiledBindingRegistry(cfg) {
	return compileConfiguredBindingRegistry({ cfg });
}
function countCompiledBindingRegistry(registry) {
	return {
		bindingCount: [...registry.rulesByChannel.values()].reduce((sum, rules) => sum + rules.length, 0),
		channelCount: registry.rulesByChannel.size
	};
}
//#endregion
//#region src/channels/plugins/configured-binding-match.ts
function resolveAccountMatchPriority(match, actual) {
	const trimmed = (match ?? "").trim();
	if (!trimmed) return actual === "default" ? 2 : 0;
	if (trimmed === "*") return 1;
	return normalizeAccountId(trimmed) === actual ? 2 : 0;
}
function matchCompiledBindingConversation(params) {
	return params.rule.provider.matchInboundConversation({
		binding: params.rule.binding,
		compiledBinding: params.rule.target,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
}
function resolveCompiledBindingChannel(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	return normalized ? normalized : null;
}
function toConfiguredBindingConversationRef(conversation) {
	const channel = resolveCompiledBindingChannel(conversation.channel);
	const conversationId = conversation.conversationId.trim();
	if (!channel || !conversationId) return null;
	return {
		channel,
		accountId: normalizeAccountId(conversation.accountId),
		conversationId,
		parentConversationId: normalizeOptionalString(conversation.parentConversationId)
	};
}
function materializeConfiguredBindingRecord(params) {
	return params.rule.targetFactory.materialize({
		accountId: normalizeAccountId(params.accountId),
		conversation: params.conversation
	});
}
function resolveMatchingConfiguredBinding(params) {
	if (!params.conversation) return null;
	let wildcardMatch = null;
	let exactMatch = null;
	for (const rule of params.rules) {
		const accountMatchPriority = resolveAccountMatchPriority(rule.accountPattern, params.conversation.accountId);
		if (accountMatchPriority === 0) continue;
		const match = matchCompiledBindingConversation({
			rule,
			conversationId: params.conversation.conversationId,
			parentConversationId: params.conversation.parentConversationId
		});
		if (!match) continue;
		const matchPriority = match.matchPriority ?? 0;
		if (accountMatchPriority === 2) {
			if (!exactMatch || matchPriority > (exactMatch.match.matchPriority ?? 0)) exactMatch = {
				rule,
				match
			};
			continue;
		}
		if (!wildcardMatch || matchPriority > (wildcardMatch.match.matchPriority ?? 0)) wildcardMatch = {
			rule,
			match
		};
	}
	return exactMatch ?? wildcardMatch;
}
//#endregion
//#region src/channels/plugins/configured-binding-session-lookup.ts
function resolveConfiguredBindingRecordBySessionKeyFromRegistry(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return null;
	for (const consumer of listConfiguredBindingConsumers()) {
		const parsed = consumer.parseSessionKey?.({ sessionKey });
		if (!parsed) continue;
		const channel = resolveCompiledBindingChannel(parsed.channel);
		if (!channel) continue;
		const rules = params.registry.rulesByChannel.get(channel);
		if (!rules || rules.length === 0) continue;
		let wildcardMatch = null;
		let exactMatch = null;
		for (const rule of rules) {
			if (rule.targetFactory.driverId !== consumer.id) continue;
			const accountMatchPriority = resolveAccountMatchPriority(rule.accountPattern, parsed.accountId);
			if (accountMatchPriority === 0) continue;
			const materializedTarget = materializeConfiguredBindingRecord({
				rule,
				accountId: parsed.accountId,
				conversation: rule.target
			});
			if (consumer.matchesSessionKey?.({
				sessionKey,
				compiledBinding: rule,
				accountId: parsed.accountId,
				materializedTarget
			}) ?? materializedTarget.record.targetSessionKey === sessionKey) {
				if (accountMatchPriority === 2) {
					exactMatch = materializedTarget;
					break;
				}
				wildcardMatch = materializedTarget;
			}
		}
		if (exactMatch) return exactMatch;
		if (wildcardMatch) return wildcardMatch;
	}
	return null;
}
//#endregion
//#region src/channels/plugins/configured-binding-registry.ts
function resolveMaterializedConfiguredBinding(params) {
	const conversation = toConfiguredBindingConversationRef(params.conversation);
	if (!conversation) return null;
	const rules = resolveCompiledBindingRegistry(params.cfg).rulesByChannel.get(conversation.channel);
	if (!rules || rules.length === 0) return null;
	const resolved = resolveMatchingConfiguredBinding({
		rules,
		conversation
	});
	if (!resolved) return null;
	return {
		conversation,
		resolved,
		materializedTarget: materializeConfiguredBindingRecord({
			rule: resolved.rule,
			accountId: conversation.accountId,
			conversation: resolved.match
		})
	};
}
function primeConfiguredBindingRegistry$1(params) {
	return countCompiledBindingRegistry(primeCompiledBindingRegistry(params.cfg));
}
function resolveConfiguredBindingRecord$1(params) {
	const conversation = toConfiguredBindingConversationRef({
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!conversation) return null;
	return resolveConfiguredBindingRecordForConversation$1({
		cfg: params.cfg,
		conversation
	});
}
function resolveConfiguredBindingRecordForConversation$1(params) {
	const resolved = resolveMaterializedConfiguredBinding(params);
	if (!resolved) return null;
	return resolved.materializedTarget;
}
function resolveConfiguredBinding$1(params) {
	const resolved = resolveMaterializedConfiguredBinding(params);
	if (!resolved) return null;
	return {
		conversation: resolved.conversation,
		compiledBinding: resolved.resolved.rule,
		match: resolved.resolved.match,
		...resolved.materializedTarget
	};
}
function resolveConfiguredBindingRecordBySessionKey$1(params) {
	return resolveConfiguredBindingRecordBySessionKeyFromRegistry({
		registry: resolveCompiledBindingRegistry(params.cfg),
		sessionKey: params.sessionKey
	});
}
//#endregion
//#region src/channels/plugins/binding-registry.ts
function primeConfiguredBindingRegistry(...args) {
	ensureConfiguredBindingBuiltinsRegistered();
	return primeConfiguredBindingRegistry$1(...args);
}
function resolveConfiguredBindingRecord(...args) {
	ensureConfiguredBindingBuiltinsRegistered();
	return resolveConfiguredBindingRecord$1(...args);
}
function resolveConfiguredBindingRecordForConversation(...args) {
	ensureConfiguredBindingBuiltinsRegistered();
	return resolveConfiguredBindingRecordForConversation$1(...args);
}
function resolveConfiguredBinding(...args) {
	ensureConfiguredBindingBuiltinsRegistered();
	return resolveConfiguredBinding$1(...args);
}
function resolveConfiguredBindingRecordBySessionKey(...args) {
	ensureConfiguredBindingBuiltinsRegistered();
	return resolveConfiguredBindingRecordBySessionKey$1(...args);
}
//#endregion
export { resolveConfiguredBindingRecordForConversation as a, resolveConfiguredAcpBindingSpecFromRecord as c, resolveConfiguredBindingRecordBySessionKey as i, toResolvedConfiguredAcpBinding as l, resolveConfiguredBinding as n, buildConfiguredAcpSessionKey as o, resolveConfiguredBindingRecord as r, normalizeBindingConfig as s, primeConfiguredBindingRegistry as t };
