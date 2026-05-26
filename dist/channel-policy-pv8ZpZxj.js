import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import "./group-policy-sKF5rlUN.js";
import { i as resolveOpenProviderRuntimeGroupPolicy, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { l as createScopedDmSecurityResolver } from "./channel-config-helpers-xZ4-bv2H.js";
import { t as collectProviderDangerousNameMatchingScopes } from "./dangerous-name-matching-jjAiM0PK.js";
import "./channel-access-compat-EGOB-mde.js";
//#region src/channels/plugins/group-policy-warnings.ts
function composeWarningCollectors(...collectors) {
	return (params) => collectors.flatMap((collector) => collector?.(params) ?? []);
}
function projectWarningCollector(project, collector) {
	return (params) => collector(project(params));
}
function projectConfigWarningCollector(collector) {
	return projectWarningCollector((params) => ({ cfg: params.cfg }), collector);
}
function projectConfigAccountIdWarningCollector(collector) {
	return projectWarningCollector((params) => ({
		cfg: params.cfg,
		accountId: params.accountId
	}), collector);
}
function projectAccountWarningCollector(collector) {
	return projectWarningCollector((params) => params.account, collector);
}
function projectAccountConfigWarningCollector(projectCfg, collector) {
	return projectWarningCollector((params) => ({
		account: params.account,
		cfg: projectCfg(params.cfg)
	}), collector);
}
function createConditionalWarningCollector(...collectors) {
	return (params) => collectors.flatMap((collector) => {
		const next = collector(params);
		if (!next) return [];
		return Array.isArray(next) ? next : [next];
	});
}
function composeAccountWarningCollectors(baseCollector, ...collectors) {
	return composeWarningCollectors(baseCollector, createConditionalWarningCollector(...collectors.map((collector) => ({ account }) => collector(account))));
}
function buildOpenGroupPolicyWarning(params) {
	return `- ${params.surface}: groupPolicy="open" ${params.openBehavior}. ${params.remediation}.`;
}
function buildOpenGroupPolicyRestrictSendersWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} to restrict senders`
	});
}
function buildOpenGroupPolicyNoRouteAllowlistWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `with no ${params.routeAllowlistPath} allowlist; any ${params.routeScope} can add + ping${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} or configure ${params.routeAllowlistPath}`
	});
}
function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params) {
	const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
	return buildOpenGroupPolicyWarning({
		surface: params.surface,
		openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
		remediation: `Set ${params.groupPolicyPath}="allowlist" and configure ${params.routeAllowlistPath}`
	});
}
function collectOpenGroupPolicyRestrictSendersWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	return [buildOpenGroupPolicyRestrictSendersWarning(params)];
}
function collectAllowlistProviderRestrictSendersWarnings(params) {
	return collectAllowlistProviderGroupPolicyWarnings({
		cfg: params.cfg,
		providerConfigPresent: params.providerConfigPresent,
		configuredGroupPolicy: params.configuredGroupPolicy,
		collect: (groupPolicy) => collectOpenGroupPolicyRestrictSendersWarnings({
			groupPolicy,
			surface: params.surface,
			openScope: params.openScope,
			groupPolicyPath: params.groupPolicyPath,
			groupAllowFromPath: params.groupAllowFromPath,
			mentionGated: params.mentionGated
		})
	});
}
/** Build an account-aware allowlist-provider warning collector for sender-restricted groups. */
function createAllowlistProviderRestrictSendersWarningCollector(params) {
	return createAllowlistProviderGroupPolicyWarningCollector({
		providerConfigPresent: params.providerConfigPresent,
		resolveGroupPolicy: ({ account }) => params.resolveGroupPolicy(account),
		collect: ({ groupPolicy }) => collectOpenGroupPolicyRestrictSendersWarnings({
			groupPolicy,
			surface: params.surface,
			openScope: params.openScope,
			groupPolicyPath: params.groupPolicyPath,
			groupAllowFromPath: params.groupAllowFromPath,
			mentionGated: params.mentionGated
		})
	});
}
/** Build a direct account-aware warning collector when the policy already lives on the account. */
function createOpenGroupPolicyRestrictSendersWarningCollector(params) {
	return (account) => collectOpenGroupPolicyRestrictSendersWarnings({
		groupPolicy: params.resolveGroupPolicy(account) ?? params.defaultGroupPolicy ?? "allowlist",
		surface: params.surface,
		openScope: params.openScope,
		groupPolicyPath: params.groupPolicyPath,
		groupAllowFromPath: params.groupAllowFromPath,
		mentionGated: params.mentionGated
	});
}
function collectAllowlistProviderGroupPolicyWarnings(params) {
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy ?? void 0,
		defaultGroupPolicy
	});
	return params.collect(groupPolicy);
}
/** Build a config-aware allowlist-provider warning collector from an arbitrary policy resolver. */
function createAllowlistProviderGroupPolicyWarningCollector(params) {
	return (runtime) => collectAllowlistProviderGroupPolicyWarnings({
		cfg: runtime.cfg,
		providerConfigPresent: params.providerConfigPresent(runtime.cfg),
		configuredGroupPolicy: params.resolveGroupPolicy(runtime),
		collect: (groupPolicy) => params.collect({
			...runtime,
			groupPolicy
		})
	});
}
function collectOpenProviderGroupPolicyWarnings(params) {
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy ?? void 0,
		defaultGroupPolicy
	});
	return params.collect(groupPolicy);
}
/** Build a config-aware open-provider warning collector from an arbitrary policy resolver. */
function createOpenProviderGroupPolicyWarningCollector(params) {
	return (runtime) => collectOpenProviderGroupPolicyWarnings({
		cfg: runtime.cfg,
		providerConfigPresent: params.providerConfigPresent(runtime.cfg),
		configuredGroupPolicy: params.resolveGroupPolicy(runtime),
		collect: (groupPolicy) => params.collect({
			...runtime,
			groupPolicy
		})
	});
}
/** Build an account-aware allowlist-provider warning collector for simple open-policy warnings. */
function createAllowlistProviderOpenWarningCollector(params) {
	return createAllowlistProviderGroupPolicyWarningCollector({
		providerConfigPresent: params.providerConfigPresent,
		resolveGroupPolicy: ({ account }) => params.resolveGroupPolicy(account),
		collect: ({ groupPolicy }) => groupPolicy === "open" ? [buildOpenGroupPolicyWarning(params.buildOpenWarning)] : []
	});
}
function collectOpenGroupPolicyRouteAllowlistWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	if (params.routeAllowlistConfigured) return [buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)];
	return [buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)];
}
/** Build an account-aware allowlist-provider warning collector for route-allowlisted groups. */
function createAllowlistProviderRouteAllowlistWarningCollector(params) {
	return createAllowlistProviderGroupPolicyWarningCollector({
		providerConfigPresent: params.providerConfigPresent,
		resolveGroupPolicy: ({ account }) => params.resolveGroupPolicy(account),
		collect: ({ account, groupPolicy }) => collectOpenGroupPolicyRouteAllowlistWarnings({
			groupPolicy,
			routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
			restrictSenders: params.restrictSenders,
			noRouteAllowlist: params.noRouteAllowlist
		})
	});
}
function collectOpenGroupPolicyConfiguredRouteWarnings(params) {
	if (params.groupPolicy !== "open") return [];
	if (params.routeAllowlistConfigured) return [buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)];
	return [buildOpenGroupPolicyWarning(params.missingRouteAllowlist)];
}
/** Build an account-aware open-provider warning collector for configured-route channels. */
function createOpenProviderConfiguredRouteWarningCollector(params) {
	return createOpenProviderGroupPolicyWarningCollector({
		providerConfigPresent: params.providerConfigPresent,
		resolveGroupPolicy: ({ account }) => params.resolveGroupPolicy(account),
		collect: ({ account, groupPolicy }) => collectOpenGroupPolicyConfiguredRouteWarnings({
			groupPolicy,
			routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
			configureRouteAllowlist: params.configureRouteAllowlist,
			missingRouteAllowlist: params.missingRouteAllowlist
		})
	});
}
//#endregion
//#region src/plugin-sdk/channel-policy.ts
function normalizeAllowFromList(list) {
	if (!Array.isArray(list)) return [];
	return list.map((value) => String(value).trim()).filter(Boolean);
}
function coerceNativeSetting(value) {
	if (value === true || value === false || value === "auto") return value;
}
function collectMutableAllowlistWarningLines(hits, channel) {
	if (hits.length === 0) return [];
	const exampleLines = hits.slice(0, 8).map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
	const remaining = hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
	const flagPaths = Array.from(new Set(hits.map((hit) => hit.dangerousFlagPath)));
	const flagHint = flagPaths.length === 1 ? sanitizeForLog(flagPaths[0] ?? "") : `${sanitizeForLog(flagPaths[0] ?? "")} (and ${flagPaths.length - 1} other scope flags)`;
	return [
		`- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across ${channel} while name matching is disabled by default.`,
		...exampleLines,
		...remaining ? [remaining] : [],
		`- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
		"- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries."
	];
}
function createDangerousNameMatchingMutableAllowlistWarningCollector(params) {
	return ({ cfg }) => {
		const hits = [];
		for (const scope of collectProviderDangerousNameMatchingScopes(cfg, params.channel)) {
			if (scope.dangerousNameMatchingEnabled) continue;
			for (const candidate of params.collectLists(scope)) {
				if (!Array.isArray(candidate.list)) continue;
				for (const entry of candidate.list) {
					const text = String(entry).trim();
					if (!text || text === "*" || !params.detector(text)) continue;
					hits.push({
						path: candidate.pathLabel,
						entry: text,
						dangerousFlagPath: scope.dangerousFlagPath
					});
				}
			}
		}
		return collectMutableAllowlistWarningLines(hits, params.channel);
	};
}
/** Compose the common DM policy resolver with restrict-senders group warnings. */
function createRestrictSendersChannelSecurity(params) {
	return {
		resolveDmPolicy: createScopedDmSecurityResolver({
			channelKey: params.channelKey,
			resolvePolicy: params.resolveDmPolicy,
			resolveAllowFrom: params.resolveDmAllowFrom,
			resolveFallbackAccountId: params.resolveFallbackAccountId,
			defaultPolicy: params.defaultDmPolicy,
			allowFromPathSuffix: params.allowFromPathSuffix,
			policyPathSuffix: params.policyPathSuffix,
			approveChannelId: params.approveChannelId,
			approveHint: params.approveHint,
			normalizeEntry: params.normalizeDmEntry,
			inheritSharedDefaultsFromDefaultAccount: params.inheritSharedDefaultsFromDefaultAccount
		}),
		collectWarnings: createAllowlistProviderRestrictSendersWarningCollector({
			providerConfigPresent: params.providerConfigPresent ?? ((cfg) => cfg.channels?.[params.channelKey] !== void 0),
			resolveGroupPolicy: params.resolveGroupPolicy,
			surface: params.surface,
			openScope: params.openScope,
			groupPolicyPath: params.groupPolicyPath,
			groupAllowFromPath: params.groupAllowFromPath,
			mentionGated: params.mentionGated
		})
	};
}
//#endregion
export { createOpenProviderGroupPolicyWarningCollector as C, projectConfigWarningCollector as D, projectConfigAccountIdWarningCollector as E, projectWarningCollector as O, createOpenProviderConfiguredRouteWarningCollector as S, projectAccountWarningCollector as T, createAllowlistProviderOpenWarningCollector as _, buildOpenGroupPolicyConfigureRouteAllowlistWarning as a, createConditionalWarningCollector as b, collectAllowlistProviderGroupPolicyWarnings as c, collectOpenGroupPolicyRestrictSendersWarnings as d, collectOpenGroupPolicyRouteAllowlistWarnings as f, createAllowlistProviderGroupPolicyWarningCollector as g, composeWarningCollectors as h, normalizeAllowFromList as i, collectAllowlistProviderRestrictSendersWarnings as l, composeAccountWarningCollectors as m, createDangerousNameMatchingMutableAllowlistWarningCollector as n, buildOpenGroupPolicyRestrictSendersWarning as o, collectOpenProviderGroupPolicyWarnings as p, createRestrictSendersChannelSecurity as r, buildOpenGroupPolicyWarning as s, coerceNativeSetting as t, collectOpenGroupPolicyConfiguredRouteWarnings as u, createAllowlistProviderRestrictSendersWarningCollector as v, projectAccountConfigWarningCollector as w, createOpenGroupPolicyRestrictSendersWarningCollector as x, createAllowlistProviderRouteAllowlistWarningCollector as y };
