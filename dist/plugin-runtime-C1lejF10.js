import { t as isTruthyEnvValue } from "./env-DL0trrAI.js";
import { s as toSafeImportPath } from "./plugin-module-loader-cache-MuKAXPrS.js";
import { C as commitPluginInteractiveCallbackDedupe, S as claimPluginInteractiveCallbackDedupe, b as resolvePluginInteractiveNamespaceMatch, w as releasePluginInteractiveCallbackDedupe } from "./types-Db71gsKA.js";
import "./hook-runner-global-aUo3QVZe.js";
import "./gateway-request-scope-v3GshBD5.js";
import { o as detachPluginConversationBinding, p as requestPluginConversationBinding, s as getCurrentPluginConversationBinding } from "./conversation-binding-mt8hjpt4.js";
import "./commands-w9uHmCLc.js";
import "./http-registry-DCa6uv2e.js";
//#region src/plugins/interactive-binding-helpers.ts
function createInteractiveConversationBindingHelpers(params) {
	const { registration, senderId, conversation } = params;
	const pluginRoot = registration.pluginRoot;
	return {
		requestConversationBinding: async (binding = {}) => {
			if (!pluginRoot) return {
				status: "error",
				message: "This interaction cannot bind the current conversation."
			};
			return requestPluginConversationBinding({
				pluginId: registration.pluginId,
				pluginName: registration.pluginName,
				pluginRoot,
				requestedBySenderId: senderId,
				conversation,
				binding
			});
		},
		detachConversationBinding: async () => {
			if (!pluginRoot) return { removed: false };
			return detachPluginConversationBinding({
				pluginRoot,
				conversation
			});
		},
		getCurrentConversationBinding: async () => {
			if (!pluginRoot) return null;
			return getCurrentPluginConversationBinding({
				pluginRoot,
				conversation
			});
		}
	};
}
//#endregion
//#region src/plugins/interactive.ts
async function dispatchPluginInteractiveHandler(params) {
	const match = resolvePluginInteractiveNamespaceMatch(params.channel, params.data);
	if (!match) return {
		matched: false,
		handled: false,
		duplicate: false
	};
	const dedupeKey = params.dedupeId?.trim();
	if (dedupeKey && !claimPluginInteractiveCallbackDedupe(dedupeKey)) return {
		matched: true,
		handled: true,
		duplicate: true
	};
	try {
		await params.onMatched?.();
		const resolved = await params.invoke(match);
		if (dedupeKey) commitPluginInteractiveCallbackDedupe(dedupeKey);
		return {
			matched: true,
			handled: resolved?.handled ?? true,
			duplicate: false
		};
	} catch (error) {
		if (dedupeKey) releasePluginInteractiveCallbackDedupe(dedupeKey);
		throw error;
	}
}
//#endregion
//#region src/plugins/lazy-service-module.ts
function resolveExport(mod, names) {
	for (const name of names) {
		const value = mod[name];
		if (typeof value === "function") return value;
	}
	return null;
}
async function defaultLoadOverrideModule(specifier, importModule = async (source) => await import(source)) {
	return importModule(toSafeImportPath(specifier));
}
async function startLazyPluginServiceModule(params) {
	const skipEnvVar = params.skipEnvVar?.trim();
	if (skipEnvVar && isTruthyEnvValue(process.env[skipEnvVar])) return null;
	const overrideEnvVar = params.overrideEnvVar?.trim();
	const override = overrideEnvVar ? process.env[overrideEnvVar]?.trim() : void 0;
	const loadOverrideModule = params.loadOverrideModule ?? defaultLoadOverrideModule;
	const validatedOverride = override && params.validateOverrideSpecifier ? params.validateOverrideSpecifier(override) : override;
	const mod = validatedOverride ? await loadOverrideModule(validatedOverride) : await params.loadDefaultModule();
	const start = resolveExport(mod, params.startExportNames);
	if (!start) return null;
	const stop = params.stopExportNames && params.stopExportNames.length > 0 ? resolveExport(mod, params.stopExportNames) : null;
	await start();
	return { stop: stop ?? (async () => {}) };
}
//#endregion
export { createInteractiveConversationBindingHelpers as i, startLazyPluginServiceModule as n, dispatchPluginInteractiveHandler as r, defaultLoadOverrideModule as t };
