import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { s as toSafeImportPath } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { C as claimPluginInteractiveCallbackDedupe, T as releasePluginInteractiveCallbackDedupe, w as commitPluginInteractiveCallbackDedupe, x as resolvePluginInteractiveNamespaceMatch } from "./command-registration-io1ALI_N.js";
import "./hook-runner-global-BkXXy1ub.js";
import "./gateway-request-scope-B9qYB9tg.js";
import { o as detachPluginConversationBinding, p as requestPluginConversationBinding, s as getCurrentPluginConversationBinding } from "./conversation-binding-CMioKWCr.js";
import "./commands-knen7QS8.js";
import "./http-registry-Dt8GAiji.js";
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
		const shouldExposeResult = !!resolved && typeof resolved === "object" && Object.keys(resolved).some((key) => key !== "handled");
		return {
			matched: true,
			handled: resolved?.handled ?? true,
			duplicate: false,
			...shouldExposeResult ? { result: resolved } : {}
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
