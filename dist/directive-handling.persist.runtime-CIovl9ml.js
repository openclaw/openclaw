import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId } from "./agent-scope-config-26EcJVc0.js";
import { p as resolveSessionAgentId } from "./agent-scope-C1Fl7gAf.js";
import { n as isThinkingLevelSupported, o as resolveSupportedThinkingLevel } from "./thinking-ix_990qw.js";
import { t as resolveAgentHarnessPolicy } from "./policy-AKMwD9k5.js";
import { s as updateSessionStore } from "./store-3qAZ3Zl6.js";
import "./model-selection-VRXWv5rs.js";
import { a as enqueueSystemEvent } from "./system-events-D_-_Inav.js";
import "./selection-61FIEezO.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-BZTQYrDg.js";
import { t as resolveModelSelectionFromDirective } from "./directive-handling.model-selection-DG1h7bUG.js";
import { r as resolveContextTokens } from "./model-selection-zb8joq0t.js";
import { n as applyVerboseOverride, t as applyTraceOverride } from "./level-overrides-BRv950_B.js";
import { r as listLegacyRuntimeModelProviderAliases } from "./model-runtime-aliases-PF4TfNSo.js";
import { n as canPersistInternalVerboseDirective, r as enqueueModeSwitchEvents, t as canPersistInternalExecDirective } from "./directive-handling.shared-Cr6GcTfl.js";
//#region src/auto-reply/reply/directive-handling.persist.ts
const MODEL_RUNTIME_CLEAR_VALUES = new Set(["auto", "default"]);
function resolveModelRuntimeOverride(params) {
	const rawRuntime = params.rawRuntime?.trim();
	if (!rawRuntime) return;
	const runtime = normalizeProviderId(rawRuntime);
	if (MODEL_RUNTIME_CLEAR_VALUES.has(runtime)) return { kind: "clear" };
	if (runtime === "pi") return {
		kind: "set",
		runtime: "pi"
	};
	const provider = normalizeProviderId(params.provider);
	for (const alias of listLegacyRuntimeModelProviderAliases()) {
		if (normalizeProviderId(alias.provider) !== provider) continue;
		const aliasRuntime = normalizeProviderId(alias.runtime);
		if (runtime === aliasRuntime || aliasRuntime === "codex" && runtime === "codex-app-server") return {
			kind: "set",
			runtime: alias.runtime
		};
	}
	return {
		kind: "invalid",
		runtime: rawRuntime
	};
}
function resolveContextConfigProviderForRuntime(params) {
	const provider = normalizeProviderId(params.provider);
	const runtimeId = normalizeProviderId(params.runtimeId ?? "");
	if (provider === "openai" && runtimeId === "codex") return "openai-codex";
	return params.provider;
}
async function persistInlineDirectives(params) {
	const { directives, cfg, sessionEntry, sessionStore, sessionKey, storePath, elevatedEnabled, elevatedAllowed, defaultProvider, defaultModel, aliasIndex, allowedModelKeys, initialModelLabel, formatModelSwitchEvent, agentCfg } = params;
	let { provider, model } = params;
	let thinkingRemap;
	const allowInternalExecPersistence = canPersistInternalExecDirective({
		messageProvider: params.messageProvider,
		surface: params.surface,
		gatewayClientScopes: params.gatewayClientScopes
	});
	const allowInternalVerbosePersistence = canPersistInternalVerboseDirective({
		messageProvider: params.messageProvider,
		surface: params.surface,
		gatewayClientScopes: params.gatewayClientScopes
	});
	const thinkingCatalog = params.thinkingCatalog && params.thinkingCatalog.length > 0 ? params.thinkingCatalog : void 0;
	const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
	const activeAgentId = sessionKey ? resolveSessionAgentId({
		sessionKey,
		config: cfg
	}) : resolveDefaultAgentId(cfg);
	const agentDir = resolveAgentDir(cfg, activeAgentId) ?? params.agentDir;
	if (sessionEntry && sessionStore && sessionKey) {
		const prevElevatedLevel = sessionEntry.elevatedLevel ?? agentCfg?.elevatedDefault ?? (elevatedAllowed ? "on" : "off");
		const prevReasoningLevel = sessionEntry.reasoningLevel ?? "off";
		let elevatedChanged = directives.hasElevatedDirective && directives.elevatedLevel !== void 0 && elevatedEnabled && elevatedAllowed;
		let reasoningChanged = directives.hasReasoningDirective && directives.reasoningLevel !== void 0;
		let updated = false;
		if (directives.clearThinkLevel) {
			if (sessionEntry.thinkingLevel) {
				delete sessionEntry.thinkingLevel;
				updated = true;
			}
		} else if (directives.hasThinkDirective && directives.thinkLevel) {
			sessionEntry.thinkingLevel = directives.thinkLevel;
			updated = true;
		}
		if (directives.clearFastMode) {
			if (sessionEntry.fastMode !== void 0) {
				delete sessionEntry.fastMode;
				updated = true;
			}
		}
		if (directives.hasVerboseDirective && directives.verboseLevel && allowInternalVerbosePersistence) {
			applyVerboseOverride(sessionEntry, directives.verboseLevel);
			updated = true;
		}
		if (directives.hasTraceDirective && directives.traceLevel && (params.senderIsOwner || delegatedTraceAllowed)) {
			applyTraceOverride(sessionEntry, directives.traceLevel);
			updated = true;
		}
		if (directives.hasReasoningDirective && directives.reasoningLevel) {
			if (directives.reasoningLevel === "off") sessionEntry.reasoningLevel = "off";
			else sessionEntry.reasoningLevel = directives.reasoningLevel;
			reasoningChanged = reasoningChanged || directives.reasoningLevel !== prevReasoningLevel && directives.reasoningLevel !== void 0;
			updated = true;
		}
		if (directives.hasElevatedDirective && directives.elevatedLevel && elevatedEnabled && elevatedAllowed) {
			sessionEntry.elevatedLevel = directives.elevatedLevel;
			elevatedChanged = elevatedChanged || directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== void 0;
			updated = true;
		}
		if (directives.hasExecDirective && directives.hasExecOptions && allowInternalExecPersistence) {
			if (directives.execHost) {
				sessionEntry.execHost = directives.execHost;
				updated = true;
			}
			if (directives.execSecurity) {
				sessionEntry.execSecurity = directives.execSecurity;
				updated = true;
			}
			if (directives.execAsk) {
				sessionEntry.execAsk = directives.execAsk;
				updated = true;
			}
			if (directives.execNode) {
				sessionEntry.execNode = directives.execNode;
				updated = true;
			}
		}
		const modelDirective = directives.hasModelDirective && params.effectiveModelDirective ? params.effectiveModelDirective : void 0;
		if (modelDirective) {
			const modelResolution = resolveModelSelectionFromDirective({
				directives: {
					...directives,
					hasModelDirective: true,
					rawModelDirective: modelDirective
				},
				cfg,
				agentDir,
				defaultProvider,
				defaultModel,
				aliasIndex,
				allowedModelKeys,
				allowedModelCatalog: [],
				provider
			});
			if (modelResolution.modelSelection) {
				const { updated: modelUpdated } = applyModelOverrideToSessionEntry({
					entry: sessionEntry,
					selection: modelResolution.modelSelection,
					profileOverride: modelResolution.profileOverride,
					markLiveSwitchPending: params.markLiveSwitchPending
				});
				const runtimeOverride = resolveModelRuntimeOverride({
					rawRuntime: directives.rawModelRuntime,
					provider: modelResolution.modelSelection.provider
				});
				if (runtimeOverride?.kind === "clear") {
					if (sessionEntry.agentRuntimeOverride) {
						delete sessionEntry.agentRuntimeOverride;
						updated = true;
					}
				} else if (runtimeOverride?.kind === "set") {
					if (sessionEntry.agentRuntimeOverride) {
						delete sessionEntry.agentRuntimeOverride;
						updated = true;
					}
					enqueueSystemEvent(`Ignored session runtime ${runtimeOverride.runtime}; configure provider or model runtime policy instead.`, {
						sessionKey,
						contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}:ignored-session-runtime`
					});
				} else if (runtimeOverride?.kind === "invalid") {
					if (sessionEntry.agentRuntimeOverride) {
						delete sessionEntry.agentRuntimeOverride;
						updated = true;
					}
					enqueueSystemEvent(`Ignored unsupported runtime ${runtimeOverride.runtime} for ${modelResolution.modelSelection.provider}.`, {
						sessionKey,
						contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}`
					});
				}
				provider = modelResolution.modelSelection.provider;
				model = modelResolution.modelSelection.model;
				const currentThinkingLevel = sessionEntry.thinkingLevel;
				if (currentThinkingLevel && !directives.hasThinkDirective && !isThinkingLevelSupported({
					provider,
					model,
					level: currentThinkingLevel,
					catalog: thinkingCatalog
				})) {
					const remappedThinkingLevel = resolveSupportedThinkingLevel({
						provider,
						model,
						level: currentThinkingLevel,
						catalog: thinkingCatalog
					});
					if (remappedThinkingLevel !== currentThinkingLevel) {
						sessionEntry.thinkingLevel = remappedThinkingLevel;
						thinkingRemap = {
							from: currentThinkingLevel,
							to: remappedThinkingLevel,
							provider,
							model
						};
						updated = true;
					}
				}
				const nextLabel = `${provider}/${model}`;
				if (nextLabel !== initialModelLabel) enqueueSystemEvent(formatModelSwitchEvent(nextLabel, modelResolution.modelSelection.alias), {
					sessionKey,
					contextKey: `model:${nextLabel}`
				});
				updated = updated || modelUpdated;
			}
		}
		if (directives.hasQueueDirective && directives.queueReset) {
			delete sessionEntry.queueMode;
			delete sessionEntry.queueDebounceMs;
			delete sessionEntry.queueCap;
			delete sessionEntry.queueDrop;
			updated = true;
		}
		if (updated) {
			sessionEntry.updatedAt = Date.now();
			sessionStore[sessionKey] = sessionEntry;
			if (storePath) await updateSessionStore(storePath, (store) => {
				store[sessionKey] = sessionEntry;
			});
			enqueueModeSwitchEvents({
				enqueueSystemEvent,
				sessionEntry,
				sessionKey,
				elevatedChanged,
				reasoningChanged
			});
		}
	}
	return {
		provider,
		model,
		thinkingRemap,
		contextTokens: resolveContextTokens({
			cfg,
			agentCfg,
			provider: resolveContextConfigProviderForRuntime({
				provider,
				runtimeId: resolveAgentHarnessPolicy({
					provider,
					modelId: model,
					config: cfg,
					agentId: activeAgentId,
					sessionKey
				}).runtime
			}),
			model
		})
	};
}
//#endregion
export { persistInlineDirectives };
