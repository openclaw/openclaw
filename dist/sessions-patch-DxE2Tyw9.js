import { c as normalizeOptionalString, i as normalizeFastMode, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { d as normalizeElevatedLevel, f as normalizeReasoningLevel, h as normalizeUsageDisplay, n as isThinkingLevelSupported, o as resolveSupportedThinkingLevel, p as normalizeThinkLevel, t as formatThinkingLevels } from "./thinking-DNSlsULp.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { Ni as ErrorCodes, Pi as errorShape, xo as parseSessionLabel } from "./protocol-DiXjp30g.js";
import { a as resolveAllowedModelRef, f as resolveSubagentConfiguredModelSelection, s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { h as normalizeInheritedToolDenylist, m as normalizeInheritedToolAllowlist } from "./subagent-capabilities-mB73wM9t.js";
import { v as normalizeExecTarget } from "./exec-approvals-Bef7TPVc.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-CUnMI0Oj.js";
import { t as normalizeSendPolicy } from "./send-policy-Dh6BW0dE.js";
import { t as normalizeGroupActivation } from "./group-activation-BxkIP-sT.js";
import { i as parseVerboseOverride, n as applyVerboseOverride, r as parseTraceOverride, t as applyTraceOverride } from "./level-overrides-BrcKBNhU.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/sessions-patch.ts
function invalid(message) {
	return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, message)
	};
}
function normalizeExecSecurity(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "deny" || normalized === "allowlist" || normalized === "full") return normalized;
}
function normalizeExecAsk(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "off" || normalized === "on-miss" || normalized === "always") return normalized;
}
function shouldPreserveSessionAuthProfileOverride(params) {
	const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
	if (!profileOverride) return false;
	const provider = normalizeOptionalLowercaseString(params.provider);
	if (!provider) return false;
	const resolvesToTargetProvider = (rawProvider) => {
		const candidate = normalizeOptionalLowercaseString(rawProvider);
		if (!candidate) return false;
		return resolveProviderIdForAuth(candidate, { config: params.cfg }) === resolveProviderIdForAuth(provider, { config: params.cfg });
	};
	const delimiterIndex = profileOverride.indexOf(":");
	if (delimiterIndex < 0) return resolvesToTargetProvider(params.currentProvider);
	const profileProvider = normalizeOptionalLowercaseString(profileOverride.slice(0, delimiterIndex));
	if (!profileProvider) return false;
	return resolvesToTargetProvider(profileProvider);
}
function supportsSpawnLineage(storeKey) {
	return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}
function normalizeSubagentRole(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "orchestrator" || normalized === "leaf") return normalized;
}
function normalizeSubagentControlScope(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "children" || normalized === "none") return normalized;
}
async function applySessionsPatchToStore(params) {
	const { cfg, store, storeKey, patch } = params;
	const now = Date.now();
	const sessionAgentId = normalizeAgentId(parseAgentSessionKey(storeKey)?.agentId ?? resolveDefaultAgentId(cfg));
	const resolvedDefault = resolveDefaultModelForAgent({
		cfg,
		agentId: sessionAgentId
	});
	const subagentModelHint = isSubagentSessionKey(storeKey) ? resolveSubagentConfiguredModelSelection({
		cfg,
		agentId: sessionAgentId
	}) : void 0;
	let loadedModelCatalog;
	const loadModelCatalogForPatch = async () => {
		if (loadedModelCatalog) return loadedModelCatalog;
		if (!params.loadGatewayModelCatalog) return;
		const catalog = await params.loadGatewayModelCatalog();
		loadedModelCatalog = Array.isArray(catalog) ? catalog : [];
		return loadedModelCatalog;
	};
	const existing = store[storeKey];
	const next = existing?.sessionId ? {
		...existing,
		updatedAt: Math.max(existing.updatedAt ?? 0, now)
	} : {
		...existing,
		sessionId: randomUUID(),
		sessionFile: void 0,
		updatedAt: Math.max(existing?.updatedAt ?? 0, now)
	};
	if (existing && !existing.sessionId) {
		delete next.label;
		delete next.displayName;
	}
	if ("spawnedBy" in patch) {
		const raw = patch.spawnedBy;
		if (raw === null) {
			if (existing?.spawnedBy) return invalid("spawnedBy cannot be cleared once set");
		} else if (raw !== void 0) {
			const trimmed = normalizeOptionalString(raw) ?? "";
			if (!trimmed) return invalid("invalid spawnedBy: empty");
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnedBy is only supported for subagent:* or acp:* sessions");
			if (existing?.spawnedBy && existing.spawnedBy !== trimmed) return invalid("spawnedBy cannot be changed once set");
			next.spawnedBy = trimmed;
		}
	}
	if ("spawnedWorkspaceDir" in patch) {
		const raw = patch.spawnedWorkspaceDir;
		if (raw === null) {
			if (existing?.spawnedWorkspaceDir) return invalid("spawnedWorkspaceDir cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnedWorkspaceDir is only supported for subagent:* or acp:* sessions");
			const trimmed = normalizeOptionalString(raw) ?? "";
			if (!trimmed) return invalid("invalid spawnedWorkspaceDir: empty");
			if (existing?.spawnedWorkspaceDir && existing.spawnedWorkspaceDir !== trimmed) return invalid("spawnedWorkspaceDir cannot be changed once set");
			next.spawnedWorkspaceDir = trimmed;
		}
	}
	if ("spawnDepth" in patch) {
		const raw = patch.spawnDepth;
		if (raw === null) {
			if (typeof existing?.spawnDepth === "number") return invalid("spawnDepth cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
			const numeric = raw;
			if (!Number.isInteger(numeric) || numeric < 0) return invalid("invalid spawnDepth (use an integer >= 0)");
			const normalized = numeric;
			if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) return invalid("spawnDepth cannot be changed once set");
			next.spawnDepth = normalized;
		}
	}
	if ("subagentRole" in patch) {
		const raw = patch.subagentRole;
		if (raw === null) {
			if (existing?.subagentRole) return invalid("subagentRole cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("subagentRole is only supported for subagent:* or acp:* sessions");
			const normalized = normalizeSubagentRole(raw);
			if (!normalized) return invalid("invalid subagentRole (use \"orchestrator\" or \"leaf\")");
			if (existing?.subagentRole && existing.subagentRole !== normalized) return invalid("subagentRole cannot be changed once set");
			next.subagentRole = normalized;
		}
	}
	if ("subagentControlScope" in patch) {
		const raw = patch.subagentControlScope;
		if (raw === null) {
			if (existing?.subagentControlScope) return invalid("subagentControlScope cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("subagentControlScope is only supported for subagent:* or acp:* sessions");
			const normalized = normalizeSubagentControlScope(raw);
			if (!normalized) return invalid("invalid subagentControlScope (use \"children\" or \"none\")");
			if (existing?.subagentControlScope && existing.subagentControlScope !== normalized) return invalid("subagentControlScope cannot be changed once set");
			next.subagentControlScope = normalized;
		}
	}
	if ("inheritedToolDeny" in patch) {
		const raw = patch.inheritedToolDeny;
		if (raw === null) delete next.inheritedToolDeny;
		else if (raw !== void 0) {
			if (!Array.isArray(raw)) return invalid("invalid inheritedToolDeny (use an array of tool names)");
			if (!supportsSpawnLineage(storeKey)) return invalid("inheritedToolDeny is only supported for subagent:* or acp:* sessions");
			const inheritedToolDeny = normalizeInheritedToolDenylist(raw);
			if (inheritedToolDeny.length > 0) next.inheritedToolDeny = inheritedToolDeny;
			else delete next.inheritedToolDeny;
		}
	}
	if ("inheritedToolAllow" in patch) {
		const raw = patch.inheritedToolAllow;
		if (raw === null) delete next.inheritedToolAllow;
		else if (raw !== void 0) {
			if (!Array.isArray(raw)) return invalid("invalid inheritedToolAllow (use an array of tool names)");
			if (!supportsSpawnLineage(storeKey)) return invalid("inheritedToolAllow is only supported for subagent:* or acp:* sessions");
			const inheritedToolAllow = normalizeInheritedToolAllowlist(raw);
			if (inheritedToolAllow.length > 0) next.inheritedToolAllow = inheritedToolAllow;
			else delete next.inheritedToolAllow;
		}
	}
	if ("label" in patch) {
		const raw = patch.label;
		if (raw === null) delete next.label;
		else if (raw !== void 0) {
			const parsed = parseSessionLabel(raw);
			if (!parsed.ok) return invalid(parsed.error);
			for (const [key, entry] of Object.entries(store)) {
				if (key === storeKey) continue;
				if (entry?.label === parsed.label) return invalid(`label already in use: ${parsed.label}`);
			}
			next.label = parsed.label;
		}
	}
	if ("thinkingLevel" in patch) {
		const raw = patch.thinkingLevel;
		if (raw === null) delete next.thinkingLevel;
		else if (raw !== void 0) {
			const normalized = normalizeThinkLevel(raw);
			if (!normalized) return invalid(`invalid thinkingLevel (use ${formatThinkingLevels(normalizeOptionalString(existing?.providerOverride) || resolvedDefault.provider, normalizeOptionalString(existing?.modelOverride) || resolvedDefault.model, "|", await loadModelCatalogForPatch())})`);
			next.thinkingLevel = normalized;
		}
	}
	if ("fastMode" in patch) {
		const raw = patch.fastMode;
		if (raw === null) delete next.fastMode;
		else if (raw !== void 0) {
			const normalized = normalizeFastMode(raw);
			if (normalized === void 0) return invalid("invalid fastMode (use true or false)");
			next.fastMode = normalized;
		}
	}
	if ("verboseLevel" in patch) {
		const raw = patch.verboseLevel;
		const parsed = parseVerboseOverride(raw);
		if (!parsed.ok) return invalid(parsed.error);
		applyVerboseOverride(next, parsed.value);
	}
	if ("traceLevel" in patch) {
		const raw = patch.traceLevel;
		const parsed = parseTraceOverride(raw);
		if (!parsed.ok) return invalid(parsed.error);
		applyTraceOverride(next, parsed.value);
	}
	if ("reasoningLevel" in patch) {
		const raw = patch.reasoningLevel;
		if (raw === null) delete next.reasoningLevel;
		else if (raw !== void 0) {
			const normalized = normalizeReasoningLevel(raw);
			if (!normalized) return invalid("invalid reasoningLevel (use \"on\"|\"off\"|\"stream\")");
			next.reasoningLevel = normalized;
		}
	}
	if ("responseUsage" in patch) {
		const raw = patch.responseUsage;
		if (raw === null) delete next.responseUsage;
		else if (raw !== void 0) {
			const normalized = normalizeUsageDisplay(raw);
			if (!normalized) return invalid("invalid responseUsage (use \"off\"|\"tokens\"|\"full\")");
			if (normalized === "off") delete next.responseUsage;
			else next.responseUsage = normalized;
		}
	}
	if ("elevatedLevel" in patch) {
		const raw = patch.elevatedLevel;
		if (raw === null) delete next.elevatedLevel;
		else if (raw !== void 0) {
			const normalized = normalizeElevatedLevel(raw);
			if (!normalized) return invalid("invalid elevatedLevel (use \"on\"|\"off\"|\"ask\"|\"full\")");
			next.elevatedLevel = normalized;
		}
	}
	if ("execHost" in patch) {
		const raw = patch.execHost;
		if (raw === null) delete next.execHost;
		else if (raw !== void 0) {
			const normalized = normalizeExecTarget(raw) ?? void 0;
			if (!normalized) return invalid("invalid execHost (use \"auto\"|\"sandbox\"|\"gateway\"|\"node\")");
			next.execHost = normalized;
		}
	}
	if ("execSecurity" in patch) {
		const raw = patch.execSecurity;
		if (raw === null) delete next.execSecurity;
		else if (raw !== void 0) {
			const normalized = normalizeExecSecurity(raw);
			if (!normalized) return invalid("invalid execSecurity (use \"deny\"|\"allowlist\"|\"full\")");
			next.execSecurity = normalized;
		}
	}
	if ("execAsk" in patch) {
		const raw = patch.execAsk;
		if (raw === null) delete next.execAsk;
		else if (raw !== void 0) {
			const normalized = normalizeExecAsk(raw);
			if (!normalized) return invalid("invalid execAsk (use \"off\"|\"on-miss\"|\"always\")");
			next.execAsk = normalized;
		}
	}
	if ("execNode" in patch) {
		const raw = patch.execNode;
		if (raw === null) delete next.execNode;
		else if (raw !== void 0) {
			const trimmed = normalizeOptionalString(raw) ?? "";
			if (!trimmed) return invalid("invalid execNode: empty");
			next.execNode = trimmed;
		}
	}
	if ("model" in patch) {
		const raw = patch.model;
		if (raw === null) applyModelOverrideToSessionEntry({
			entry: next,
			selection: {
				provider: resolvedDefault.provider,
				model: resolvedDefault.model,
				isDefault: true
			},
			preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
				cfg,
				currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
				entry: next,
				provider: resolvedDefault.provider
			}),
			markLiveSwitchPending: true
		});
		else if (raw !== void 0) {
			const trimmed = normalizeOptionalString(raw) ?? "";
			if (!trimmed) return invalid("invalid model: empty");
			if (!params.loadGatewayModelCatalog) return {
				ok: false,
				error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable")
			};
			const catalog = await loadModelCatalogForPatch();
			if (!catalog) return {
				ok: false,
				error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable")
			};
			const resolved = resolveAllowedModelRef({
				cfg,
				catalog,
				raw: trimmed,
				defaultProvider: resolvedDefault.provider,
				defaultModel: subagentModelHint ?? resolvedDefault.model
			});
			if ("error" in resolved) return invalid(resolved.error);
			const isDefault = resolved.ref.provider === resolvedDefault.provider && resolved.ref.model === resolvedDefault.model;
			applyModelOverrideToSessionEntry({
				entry: next,
				selection: {
					provider: resolved.ref.provider,
					model: resolved.ref.model,
					isDefault
				},
				preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
					cfg,
					currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
					entry: next,
					provider: resolved.ref.provider
				}),
				markLiveSwitchPending: true
			});
		}
	}
	if (next.thinkingLevel) {
		const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
		const effectiveModel = next.modelOverride ?? resolvedDefault.model;
		const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
		const thinkingCatalog = await loadModelCatalogForPatch();
		if (!thinkingLevel) delete next.thinkingLevel;
		else if (!isThinkingLevelSupported({
			provider: effectiveProvider,
			model: effectiveModel,
			level: thinkingLevel,
			catalog: thinkingCatalog
		})) {
			if ("thinkingLevel" in patch) return invalid(`thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${formatThinkingLevels(effectiveProvider, effectiveModel, "|", thinkingCatalog)})`);
			next.thinkingLevel = resolveSupportedThinkingLevel({
				provider: effectiveProvider,
				model: effectiveModel,
				level: thinkingLevel,
				catalog: thinkingCatalog
			});
		}
	}
	if ("sendPolicy" in patch) {
		const raw = patch.sendPolicy;
		if (raw === null) delete next.sendPolicy;
		else if (raw !== void 0) {
			const normalized = normalizeSendPolicy(raw);
			if (!normalized) return invalid("invalid sendPolicy (use \"allow\"|\"deny\")");
			next.sendPolicy = normalized;
		}
	}
	if ("groupActivation" in patch) {
		const raw = patch.groupActivation;
		if (raw === null) delete next.groupActivation;
		else if (raw !== void 0) {
			const normalized = normalizeGroupActivation(raw);
			if (!normalized) return invalid("invalid groupActivation (use \"mention\"|\"always\")");
			next.groupActivation = normalized;
		}
	}
	store[storeKey] = next;
	return {
		ok: true,
		entry: next
	};
}
//#endregion
export { applySessionsPatchToStore as t };
