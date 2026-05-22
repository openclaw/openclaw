import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as resolveAgentHarnessPolicy } from "./policy-Dm1neGPw.js";
import { r as withActivatedPluginIds } from "./activation-context-BdiAp303.js";
import { u as resolveStorePath } from "./paths-izP4MuZ5.js";
import { c as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-CYzFXvuT.js";
import { s as updateSessionStore } from "./store-MLsIinKe.js";
import { i as normalizeStoredOverrideModel, s as resolveDefaultModelForAgent, u as resolvePersistedSelectedModelRef } from "./model-selection-BxUseaAH.js";
import "./runs-B0OF6UPV.js";
//#region src/agents/harness/runtime-plugin.ts
async function ensureSelectedAgentHarnessPlugin(params) {
	const runtimeOverride = params.agentHarnessRuntimeOverride?.trim();
	const policy = resolveAgentHarnessPolicy({
		provider: params.provider,
		modelId: params.modelId,
		config: params.config,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	if ((runtimeOverride && runtimeOverride !== "auto" && runtimeOverride !== "default" ? runtimeOverride : policy.runtime) !== "codex") return;
	const { ensurePluginRegistryLoaded } = await import("./runtime-registry-loader-DbPA9Qb_.js");
	const activatedConfig = withActivatedPluginIds({
		config: params.config,
		pluginIds: ["codex"]
	}) ?? params.config;
	ensurePluginRegistryLoaded({
		scope: "all",
		...activatedConfig ? {
			config: activatedConfig,
			activationSourceConfig: activatedConfig
		} : {},
		workspaceDir: params.workspaceDir,
		onlyPluginIds: ["codex"]
	});
}
//#endregion
//#region src/agents/live-model-switch.ts
function resolveLiveSessionModelSelection(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return null;
	const agentId = normalizeOptionalString(params.agentId);
	const defaultModelRef = agentId ? resolveDefaultModelForAgent({
		cfg,
		agentId
	}) : {
		provider: params.defaultProvider,
		model: params.defaultModel
	};
	const entry = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }), { skipCache: true })[sessionKey];
	const normalizedSelection = normalizeStoredOverrideModel({
		providerOverride: entry?.providerOverride,
		modelOverride: entry?.modelOverride
	});
	const persisted = resolvePersistedSelectedModelRef({
		defaultProvider: defaultModelRef.provider,
		runtimeProvider: entry?.modelProvider,
		runtimeModel: entry?.model,
		overrideProvider: normalizedSelection.providerOverride,
		overrideModel: normalizedSelection.modelOverride
	});
	const provider = persisted?.provider ?? normalizedSelection.providerOverride ?? entry?.providerOverride?.trim() ?? defaultModelRef.provider;
	const model = persisted?.model ?? defaultModelRef.model;
	const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
	return {
		provider,
		model,
		authProfileId,
		authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : void 0
	};
}
function hasDifferentLiveSessionModelSelection(current, next) {
	if (!next) return false;
	return current.provider !== next.provider || current.model !== next.model || normalizeOptionalString(current.authProfileId) !== next.authProfileId || (normalizeOptionalString(current.authProfileId) ? current.authProfileIdSource : void 0) !== next.authProfileIdSource;
}
/**
* Check whether a user-initiated live model switch is pending for the given
* session.  Returns the persisted model selection when the session's
* `liveModelSwitchPending` flag is `true` AND the persisted selection differs
* from the currently running model; otherwise returns `undefined`.
*
* When the flag is set but the current model already matches the persisted
* selection (e.g. the switch was applied as an override and the current
* attempt is already using the new model), the flag is consumed (cleared)
* eagerly to prevent it from persisting as stale state.
*
* **Deferral semantics:** The caller in `run.ts` only acts on the returned
* selection when `canRestartForLiveSwitch` is `true`.  If the run cannot
* restart (e.g. a tool call is in progress), the flag intentionally remains
* set so the switch fires on the next clean retry opportunity — even if that
* falls into a subsequent user turn.
*
* This replaces the previous approach that used an in-memory map
* (`consumeEmbeddedRunModelSwitch`) which could not distinguish between
* user-initiated `/model` switches and system-initiated fallback rotations.
*/
function shouldSwitchToLiveModel(params) {
	const sessionKey = params.sessionKey?.trim();
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return;
	if (!loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: params.agentId?.trim() }), { skipCache: true })[sessionKey]?.liveModelSwitchPending) return;
	const persisted = resolveLiveSessionModelSelection({
		cfg,
		sessionKey,
		agentId: params.agentId,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel
	});
	if (!hasDifferentLiveSessionModelSelection({
		provider: params.currentProvider,
		model: params.currentModel,
		authProfileId: params.currentAuthProfileId,
		authProfileIdSource: params.currentAuthProfileIdSource
	}, persisted)) {
		clearLiveModelSwitchPending({
			cfg,
			sessionKey,
			agentId: params.agentId
		}).catch(() => {});
		return;
	}
	return persisted ?? void 0;
}
/**
* Clear the `liveModelSwitchPending` flag from the session entry on disk so
* subsequent retry iterations do not re-trigger the switch.
*/
async function clearLiveModelSwitchPending(params) {
	const sessionKey = params.sessionKey?.trim();
	const cfg = params.cfg;
	if (!cfg || !sessionKey) return;
	const storePath = resolveStorePath(cfg.session?.store, { agentId: params.agentId?.trim() });
	if (!storePath) return;
	await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const entry = resolved.existing;
		if (entry) {
			delete entry.liveModelSwitchPending;
			store[resolved.normalizedKey] = entry;
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}
	});
}
//#endregion
export { shouldSwitchToLiveModel as n, ensureSelectedAgentHarnessPlugin as r, clearLiveModelSwitchPending as t };
