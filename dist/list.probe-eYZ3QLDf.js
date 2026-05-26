import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { d as normalizeSecretInputString, o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as resolveSecretRefString } from "./resolve-D1Ko6pWx.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { l as resolveSessionTranscriptsDirForAgent, o as resolveSessionTranscriptPath } from "./paths-Bg3PO6Gj.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { i as parseModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import "./workspace-DTx8zuCN.js";
import { r as describeFailoverError } from "./failover-error-CZCIurQK.js";
import { i as resolveAuthProfileDisplayLabel } from "./auth-profiles-D6NMnufG.js";
import { o as externalCliDiscoveryScoped } from "./external-cli-discovery-D0JQl8du.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { i as resolveAuthProfileOrder, r as resolveAuthProfileEligibility } from "./order-DJrj83KE.js";
import { l as hasUsableCustomProviderApiKey } from "./model-auth-Db-JGIrg.js";
import { r as formatMs } from "./shared-CXerptPG.js";
import { f as redactSecrets } from "./format-qvQo2sAg.js";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region src/commands/models/list.probe.ts
const PROBE_PROMPT = "Reply with OK. Do not use tools.";
const embeddedRunnerModuleLoader = createLazyImportLoader(() => import("./pi-embedded-DZrk-PV0.js"));
function loadEmbeddedRunnerModule() {
	return embeddedRunnerModuleLoader.load();
}
function mapFailoverReasonToProbeStatus(reason) {
	if (!reason) return "unknown";
	if (reason === "auth" || reason === "auth_permanent") return "auth";
	if (reason === "rate_limit" || reason === "overloaded") return "rate_limit";
	if (reason === "billing") return "billing";
	if (reason === "timeout") return "timeout";
	if (reason === "model_not_found") return "format";
	if (reason === "format") return "format";
	return "unknown";
}
function buildCandidateMap(modelCandidates) {
	const map = /* @__PURE__ */ new Map();
	for (const raw of modelCandidates) {
		const parsed = parseModelRef(raw ?? "", DEFAULT_PROVIDER);
		if (!parsed) continue;
		const list = map.get(parsed.provider) ?? [];
		if (!list.includes(parsed.model)) list.push(parsed.model);
		map.set(parsed.provider, list);
	}
	return map;
}
function catalogProbePriority(provider, modelId) {
	const id = modelId.trim().toLowerCase();
	if (provider !== "anthropic") return 50;
	if (/^claude-haiku-4-5-\d{8}$/.test(id)) return 0;
	if (id === "claude-haiku-4-5") return 1;
	if (id === "claude-sonnet-4-6" || id.startsWith("claude-sonnet-4-6-")) return 2;
	if (id.startsWith("claude-sonnet-4-")) return 3;
	if (id.startsWith("claude-3-")) return 100;
	return 50;
}
function selectProbeModel(params) {
	const { provider, candidates, catalog } = params;
	const direct = candidates.get(provider);
	if (direct && direct.length > 0) return {
		provider,
		model: direct[0]
	};
	const fromCatalog = catalog.map((entry, index) => ({
		entry,
		index
	})).filter(({ entry }) => normalizeProviderId(entry.provider) === provider).toSorted((left, right) => {
		return catalogProbePriority(provider, left.entry.id) - catalogProbePriority(provider, right.entry.id) || left.index - right.index;
	})[0]?.entry;
	if (fromCatalog) return {
		provider,
		model: fromCatalog.id
	};
	return null;
}
function mapEligibilityReasonToProbeReasonCode(reasonCode) {
	if (reasonCode === "missing_credential") return "missing_credential";
	if (reasonCode === "expired") return "expired";
	if (reasonCode === "invalid_expires") return "invalid_expires";
	if (reasonCode === "unresolved_ref") return "unresolved_ref";
	return "ineligible_profile";
}
function formatMissingCredentialProbeError(reasonCode) {
	const legacyLine = "Auth profile credentials are missing or expired.";
	if (reasonCode === "expired") return `${legacyLine}\n↳ Auth reason [expired]: token credentials are expired.`;
	if (reasonCode === "invalid_expires") return `${legacyLine}\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.`;
	if (reasonCode === "missing_credential") return `${legacyLine}\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.`;
	if (reasonCode === "unresolved_ref") return `${legacyLine}\n↳ Auth reason [unresolved_ref]: configured SecretRef could not be resolved.`;
	return `${legacyLine}\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.`;
}
function resolveProbeSecretRef(profile, cfg) {
	const defaults = cfg.secrets?.defaults;
	if (profile.type === "api_key") {
		if (normalizeSecretInputString(profile.key) !== void 0) return null;
		return coerceSecretRef(profile.keyRef, defaults);
	}
	if (profile.type === "token") {
		if (normalizeSecretInputString(profile.token) !== void 0) return null;
		return coerceSecretRef(profile.tokenRef, defaults);
	}
	return null;
}
function formatUnresolvedRefProbeError(refLabel) {
	return `Auth profile credentials are missing or expired.\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}
async function maybeResolveUnresolvedRefIssue(params) {
	if (!params.profile) return null;
	const ref = resolveProbeSecretRef(params.profile, params.cfg);
	if (!ref) return null;
	try {
		await resolveSecretRefString(ref, {
			config: params.cfg,
			env: process.env,
			cache: params.cache
		});
		return null;
	} catch {
		return {
			reasonCode: "unresolved_ref",
			error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`)
		};
	}
}
async function buildProbeTargets(params) {
	const { cfg, agentDir, providers, modelCandidates, options, workspaceDir } = params;
	const store = ensureAuthProfileStore(agentDir, { externalCli: externalCliDiscoveryScoped({
		config: cfg,
		allowKeychainPrompt: false,
		providerIds: providers,
		profileIds: options.profileIds
	}) });
	const providerFilter = options.provider?.trim();
	const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
	const profileFilter = new Set((options.profileIds ?? []).map((id) => id.trim()).filter(Boolean));
	const refResolveCache = {};
	const catalog = await loadModelCatalog({ config: cfg });
	const candidates = buildCandidateMap(modelCandidates);
	const targets = [];
	const results = [];
	for (const provider of providers) {
		const providerKey = normalizeProviderId(provider);
		if (providerFilterKey && providerKey !== providerFilterKey) continue;
		const model = selectProbeModel({
			provider: providerKey,
			candidates,
			catalog
		});
		const profileIds = listProfilesForProvider(store, providerKey);
		const explicitOrder = findNormalizedProviderValue(store.order, providerKey) ?? findNormalizedProviderValue(cfg?.auth?.order, providerKey);
		const allowedProfiles = explicitOrder && explicitOrder.length > 0 ? new Set(resolveAuthProfileOrder({
			cfg,
			store,
			provider: providerKey
		})) : null;
		const filteredProfiles = profileFilter.size ? profileIds.filter((id) => profileFilter.has(id)) : profileIds;
		if (filteredProfiles.length > 0) {
			for (const profileId of filteredProfiles) {
				const profile = store.profiles[profileId];
				const mode = profile?.type;
				const label = resolveAuthProfileDisplayLabel({
					cfg,
					store,
					profileId
				});
				if (explicitOrder && !explicitOrder.includes(profileId)) {
					results.push({
						provider: providerKey,
						profileId,
						model: model ? `${model.provider}/${model.model}` : void 0,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode: "excluded_by_auth_order",
						error: "Excluded by auth.order for this provider."
					});
					continue;
				}
				if (allowedProfiles && !allowedProfiles.has(profileId)) {
					const reasonCode = mapEligibilityReasonToProbeReasonCode(resolveAuthProfileEligibility({
						cfg,
						store,
						provider: providerKey,
						profileId
					}).reasonCode);
					results.push({
						provider: providerKey,
						model: model ? `${model.provider}/${model.model}` : void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode,
						error: formatMissingCredentialProbeError(reasonCode)
					});
					continue;
				}
				const unresolvedRefIssue = await maybeResolveUnresolvedRefIssue({
					cfg,
					profile,
					cache: refResolveCache
				});
				if (unresolvedRefIssue) {
					results.push({
						provider: providerKey,
						model: model ? `${model.provider}/${model.model}` : void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode: unresolvedRefIssue.reasonCode,
						error: unresolvedRefIssue.error
					});
					continue;
				}
				if (!model) {
					results.push({
						provider: providerKey,
						model: void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "no_model",
						reasonCode: "no_model",
						error: "No model available for probe"
					});
					continue;
				}
				targets.push({
					provider: providerKey,
					model,
					profileId,
					label,
					source: "profile",
					mode
				});
			}
			continue;
		}
		if (profileFilter.size > 0) continue;
		const envKey = resolveEnvApiKey(providerKey, process.env, {
			config: cfg,
			workspaceDir
		});
		const hasUsableModelsJsonKey = hasUsableCustomProviderApiKey(cfg, providerKey);
		if (!envKey && !hasUsableModelsJsonKey) continue;
		const label = envKey ? "env" : "models.json";
		const source = envKey ? "env" : "models.json";
		const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";
		if (!model) {
			results.push({
				provider: providerKey,
				model: void 0,
				label,
				source,
				mode,
				status: "no_model",
				reasonCode: "no_model",
				error: "No model available for probe"
			});
			continue;
		}
		targets.push({
			provider: providerKey,
			model,
			label,
			source,
			mode
		});
	}
	return {
		targets,
		results
	};
}
async function probeTarget(params) {
	const { cfg, agentId, agentDir, workspaceDir, sessionDir, target, timeoutMs, maxTokens } = params;
	if (!target.model) return {
		provider: target.provider,
		model: void 0,
		profileId: target.profileId,
		label: target.label,
		source: target.source,
		mode: target.mode,
		status: "no_model",
		reasonCode: "no_model",
		error: "No model available for probe"
	};
	const model = target.model;
	const sessionId = `probe-${target.provider}-${crypto.randomUUID()}`;
	const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
	await fs.mkdir(sessionDir, { recursive: true });
	const start = Date.now();
	const buildResult = (status, error) => ({
		provider: target.provider,
		model: `${model.provider}/${model.model}`,
		profileId: target.profileId,
		label: target.label,
		source: target.source,
		mode: target.mode,
		status,
		...error ? { error } : {},
		latencyMs: Date.now() - start
	});
	try {
		const { runEmbeddedPiAgent } = await loadEmbeddedRunnerModule();
		await runEmbeddedPiAgent({
			sessionId,
			sessionFile,
			agentId,
			workspaceDir,
			agentDir,
			config: cfg,
			prompt: PROBE_PROMPT,
			provider: target.model.provider,
			model: target.model.model,
			authProfileId: target.profileId,
			authProfileIdSource: target.profileId ? "user" : void 0,
			timeoutMs,
			runId: `probe-${crypto.randomUUID()}`,
			lane: `auth-probe:${target.provider}:${target.profileId ?? target.source}`,
			thinkLevel: "off",
			reasoningLevel: "off",
			verboseLevel: "off",
			streamParams: { maxTokens },
			disableTools: true,
			cleanupBundleMcpOnRunEnd: true
		});
		return buildResult("ok");
	} catch (err) {
		const described = describeFailoverError(err);
		return buildResult(mapFailoverReasonToProbeStatus(described.reason), redactSecrets(described.message));
	}
}
async function runTargetsWithConcurrency(params) {
	const { cfg, targets, timeoutMs, maxTokens, onProgress } = params;
	const concurrency = Math.max(1, Math.min(targets.length || 1, params.concurrency));
	const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
	const agentDir = params.agentDir ?? resolveAgentDir(cfg, agentId);
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const sessionDir = resolveSessionTranscriptsDirForAgent(agentId);
	await fs.mkdir(workspaceDir, { recursive: true });
	let completed = 0;
	const results = Array.from({ length: targets.length });
	let cursor = 0;
	const worker = async () => {
		while (true) {
			const index = cursor;
			cursor += 1;
			if (index >= targets.length) return;
			const target = targets[index];
			onProgress?.({
				completed,
				total: targets.length,
				label: `Probing ${target.provider}${target.profileId ? ` (${target.label})` : ""}`
			});
			results[index] = await probeTarget({
				cfg,
				agentId,
				agentDir,
				workspaceDir,
				sessionDir,
				target,
				timeoutMs,
				maxTokens
			});
			completed += 1;
			onProgress?.({
				completed,
				total: targets.length
			});
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results.filter((entry) => Boolean(entry));
}
async function runAuthProbes(params) {
	const startedAt = Date.now();
	const plan = await buildProbeTargets({
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		providers: params.providers,
		modelCandidates: params.modelCandidates,
		options: params.options
	});
	const totalTargets = plan.targets.length;
	params.onProgress?.({
		completed: 0,
		total: totalTargets
	});
	const results = totalTargets ? await runTargetsWithConcurrency({
		cfg: params.cfg,
		agentId: params.agentId,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		targets: plan.targets,
		timeoutMs: params.options.timeoutMs,
		maxTokens: params.options.maxTokens,
		concurrency: params.options.concurrency,
		onProgress: params.onProgress
	}) : [];
	const finishedAt = Date.now();
	return {
		startedAt,
		finishedAt,
		durationMs: finishedAt - startedAt,
		totalTargets,
		options: params.options,
		results: [...plan.results, ...results]
	};
}
function formatProbeLatency(latencyMs) {
	if (!latencyMs && latencyMs !== 0) return "-";
	return formatMs(latencyMs);
}
function groupProbeResults(results) {
	const map = /* @__PURE__ */ new Map();
	for (const result of results) {
		const list = map.get(result.provider) ?? [];
		list.push(result);
		map.set(result.provider, list);
	}
	return map;
}
function sortProbeResults(results) {
	return results.slice().toSorted((a, b) => {
		const provider = a.provider.localeCompare(b.provider);
		if (provider !== 0) return provider;
		const aLabel = a.label || a.profileId || "";
		const bLabel = b.label || b.profileId || "";
		return aLabel.localeCompare(bLabel);
	});
}
function describeProbeSummary(summary) {
	if (summary.totalTargets === 0) return "No probe targets.";
	return `Probed ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
//#endregion
export { buildProbeTargets, describeProbeSummary, formatProbeLatency, groupProbeResults, mapFailoverReasonToProbeStatus, runAuthProbes, sortProbeResults };
