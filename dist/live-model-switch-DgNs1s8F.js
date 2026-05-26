import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { i as normalizeStoredOverrideModel, s as resolveDefaultModelForAgent, u as resolvePersistedSelectedModelRef } from "./model-selection-P-81eBKx.js";
import "./runs-DrbsiywK.js";
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
		const entry = store[sessionKey];
		if (entry) delete entry.liveModelSwitchPending;
	});
}
//#endregion
export { shouldSwitchToLiveModel as n, clearLiveModelSwitchPending as t };
