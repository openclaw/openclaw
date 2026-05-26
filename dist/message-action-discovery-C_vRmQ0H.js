import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { i as listChannelPlugins, n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
//#region src/channels/plugins/message-tool-api.ts
const MESSAGE_TOOL_API_ARTIFACT_BASENAME = "message-tool-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";
function loadBundledChannelMessageToolApi(channelId) {
	const cacheKey = channelId.trim();
	try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: cacheKey,
			artifactBasename: MESSAGE_TOOL_API_ARTIFACT_BASENAME
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) return;
		throw error;
	}
}
function resolveBundledChannelMessageToolDiscoveryAdapter(channelId) {
	const describeMessageTool = loadBundledChannelMessageToolApi(channelId)?.describeMessageTool;
	if (typeof describeMessageTool !== "function") return;
	return { describeMessageTool };
}
//#endregion
//#region src/channels/plugins/message-action-discovery.ts
const loggedMessageActionErrors = /* @__PURE__ */ new Set();
function resolveMessageActionDiscoveryChannelId(raw) {
	return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}
function createMessageActionDiscoveryContext(params) {
	const currentChannelProvider = resolveMessageActionDiscoveryChannelId(params.channel ?? params.currentChannelProvider);
	return {
		cfg: params.cfg ?? {},
		currentChannelId: params.currentChannelId,
		currentChannelProvider,
		currentThreadTs: params.currentThreadTs,
		currentMessageId: params.currentMessageId,
		accountId: params.accountId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		requesterSenderId: params.requesterSenderId,
		senderIsOwner: params.senderIsOwner
	};
}
function logMessageActionError(params) {
	const message = formatErrorMessage(params.error);
	const key = `${params.pluginId}:${params.operation}:${message}`;
	if (loggedMessageActionErrors.has(key)) return;
	loggedMessageActionErrors.add(key);
	const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
	defaultRuntime.error?.(`[message-action-discovery] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`);
}
function describeMessageToolSafely(params) {
	try {
		return params.describeMessageTool(params.context) ?? null;
	} catch (error) {
		logMessageActionError({
			pluginId: params.pluginId,
			operation: "describeMessageTool",
			error
		});
		return null;
	}
}
function normalizeToolSchemaContributions(value) {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}
function normalizeMessageToolMediaSourceParams(mediaSourceParams, action) {
	if (Array.isArray(mediaSourceParams)) return mediaSourceParams;
	if (!mediaSourceParams || typeof mediaSourceParams !== "object") return [];
	const scopedMediaSourceParams = mediaSourceParams;
	if (action) {
		const scoped = scopedMediaSourceParams[action];
		return Array.isArray(scoped) ? scoped : [];
	}
	return Object.values(scopedMediaSourceParams).flatMap((scoped) => Array.isArray(scoped) ? scoped : []);
}
function resolveCurrentChannelMessageToolDiscoveryAdapter(channel) {
	const channelId = resolveMessageActionDiscoveryChannelId(channel);
	if (!channelId) return null;
	const loadedPlugin = getLoadedChannelPlugin(channelId);
	if (loadedPlugin?.actions) return {
		pluginId: loadedPlugin.id,
		actions: loadedPlugin.actions
	};
	const bundledActions = resolveBundledChannelMessageToolDiscoveryAdapter(channelId);
	if (bundledActions) return {
		pluginId: channelId,
		actions: bundledActions
	};
	const plugin = getChannelPlugin(channelId);
	if (!plugin?.actions) return null;
	return {
		pluginId: plugin.id,
		actions: plugin.actions
	};
}
function resolveMessageActionDiscoveryForPlugin(params) {
	const adapter = params.actions;
	if (!adapter) return {
		actions: [],
		capabilities: [],
		schemaContributions: [],
		mediaSourceParams: []
	};
	const described = describeMessageToolSafely({
		pluginId: params.pluginId,
		context: params.context,
		describeMessageTool: adapter.describeMessageTool
	});
	return {
		actions: params.includeActions && Array.isArray(described?.actions) ? [...described.actions] : [],
		capabilities: params.includeCapabilities && Array.isArray(described?.capabilities) ? described.capabilities : [],
		schemaContributions: params.includeSchema ? normalizeToolSchemaContributions(described?.schema) : [],
		mediaSourceParams: normalizeMessageToolMediaSourceParams(described?.mediaSourceParams, params.action)
	};
}
function listCrossChannelSchemaSupportedMessageActions(params) {
	const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
	if (!channelId) return [];
	const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
	if (!pluginActions?.actions) return [];
	const resolved = resolveMessageActionDiscoveryForPlugin({
		pluginId: pluginActions.pluginId,
		actions: pluginActions.actions,
		context: createMessageActionDiscoveryContext(params),
		includeActions: true,
		includeSchema: true
	});
	const schemaBlockedActions = /* @__PURE__ */ new Set();
	for (const contribution of resolved.schemaContributions) {
		if ((contribution.visibility ?? "current-channel") !== "current-channel") continue;
		if (!Object.hasOwn(contribution, "actions")) return [];
		const actions = contribution.actions;
		if (!Array.isArray(actions)) return [];
		if (actions.length === 0) continue;
		for (const action of actions) schemaBlockedActions.add(action);
	}
	return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}
function listChannelMessageCapabilities(cfg) {
	const capabilities = /* @__PURE__ */ new Set();
	for (const plugin of listChannelPlugins()) for (const capability of resolveMessageActionDiscoveryForPlugin({
		pluginId: plugin.id,
		actions: plugin.actions,
		context: { cfg },
		includeCapabilities: true
	}).capabilities) capabilities.add(capability);
	return Array.from(capabilities);
}
function listChannelMessageCapabilitiesForChannel(params) {
	const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
	if (!pluginActions) return [];
	return Array.from(resolveMessageActionDiscoveryForPlugin({
		pluginId: pluginActions.pluginId,
		actions: pluginActions.actions,
		context: createMessageActionDiscoveryContext(params),
		includeCapabilities: true
	}).capabilities);
}
function mergeToolSchemaProperties(target, source) {
	if (!source) return;
	for (const [name, schema] of Object.entries(source)) if (!(name in target)) target[name] = schema;
}
function resolveChannelMessageToolSchemaProperties(params) {
	const properties = {};
	const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
	const discoveryBase = createMessageActionDiscoveryContext(params);
	const seenPluginIds = /* @__PURE__ */ new Set();
	for (const plugin of listChannelPlugins()) {
		if (!plugin.actions) continue;
		seenPluginIds.add(plugin.id);
		for (const contribution of resolveMessageActionDiscoveryForPlugin({
			pluginId: plugin.id,
			actions: plugin.actions,
			context: discoveryBase,
			includeSchema: true
		}).schemaContributions) {
			const visibility = contribution.visibility ?? "current-channel";
			if (currentChannel) {
				if (visibility === "all-configured" || plugin.id === currentChannel) mergeToolSchemaProperties(properties, contribution.properties);
				continue;
			}
			mergeToolSchemaProperties(properties, contribution.properties);
		}
	}
	if (currentChannel && !seenPluginIds.has(currentChannel)) {
		const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(currentChannel);
		if (currentActions?.actions) {
			for (const contribution of resolveMessageActionDiscoveryForPlugin({
				pluginId: currentActions.pluginId,
				actions: currentActions.actions,
				context: discoveryBase,
				includeSchema: true
			}).schemaContributions) if ((contribution.visibility ?? "current-channel") === "all-configured" || currentActions.pluginId === currentChannel) mergeToolSchemaProperties(properties, contribution.properties);
		}
	}
	return properties;
}
function resolveChannelMessageToolMediaSourceParamKeys(params) {
	const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
	if (!pluginActions) return [];
	const described = resolveMessageActionDiscoveryForPlugin({
		pluginId: pluginActions.pluginId,
		actions: pluginActions.actions,
		context: createMessageActionDiscoveryContext(params),
		action: params.action,
		includeSchema: false
	});
	return Array.from(new Set(described.mediaSourceParams));
}
function channelSupportsMessageCapability(cfg, capability) {
	return listChannelMessageCapabilities(cfg).includes(capability);
}
function channelSupportsMessageCapabilityForChannel(params, capability) {
	return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}
//#endregion
export { resolveChannelMessageToolMediaSourceParamKeys as a, resolveMessageActionDiscoveryChannelId as c, listCrossChannelSchemaSupportedMessageActions as i, resolveMessageActionDiscoveryForPlugin as l, channelSupportsMessageCapabilityForChannel as n, resolveChannelMessageToolSchemaProperties as o, createMessageActionDiscoveryContext as r, resolveCurrentChannelMessageToolDiscoveryAdapter as s, channelSupportsMessageCapability as t };
