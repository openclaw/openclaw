import { n as findNormalizedProviderValue } from "./provider-id-zTW9Rdln.js";
import { v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { i as resolveAuthProfileOrder, r as resolveAuthProfileEligibility } from "./order-DJrj83KE.js";
import { o as resolveProfileUnusableUntilForDisplay } from "./usage-DbhCKKrr.js";
import "./agent-runtime-Lc7H-PlR.js";
import { a as isCodexFastServiceTier, l as resolveCodexAppServerRuntimeOptions } from "./config-CRe1vCzw.js";
import { n as listCodexAppServerModels, t as listAllCodexAppServerModels } from "./models-SwFVvMcz.js";
import { t as isJsonObject } from "./protocol-oeJQu4rs.js";
import { i as readCodexAppServerBinding, o as writeCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-CYVAOy_8.js";
import { n as CODEX_CONTROL_METHODS, r as describeControlFailure, t as requestCodexAppServerJson } from "./request-DXsJgAdp.js";
import { _ as summarizeCodexAccountUsage, a as buildHelp, c as formatCodexStatus, d as formatModels, f as formatThreads, l as formatComputerUseStatus, o as formatAccount, p as readString$1, s as formatCodexDisplayText, u as formatList } from "./notification-correlation-qKY_sgga.js";
import { n as resolveCodexNativeExecutionBlock, r as resolveCodexNativeSandboxBlock } from "./sandbox-guard-DgNmSc4f.js";
import { _ as steerCodexConversationTurn, b as readCodexConversationBindingData, d as parseCodexFastModeArg, f as parseCodexPermissionsModeArg, g as setCodexConversationPermissions, h as setCodexConversationModel, l as startCodexConversationThread, m as setCodexConversationFastMode, p as readCodexConversationActiveTurn, r as formatCodexCliSessions, u as formatPermissionsMode, v as stopCodexConversationTurn, x as resolveCodexDefaultWorkspaceDir, y as createCodexCliNodeConversationBindingData } from "./node-cli-sessions-BJ6eiycJ.js";
import { n as installCodexComputerUse, r as readCodexComputerUseStatus } from "./computer-use-DBKdqYM0.js";
import { n as rememberCodexRateLimits } from "./rate-limit-cache-N66I-Rd7.js";
import crypto from "node:crypto";
//#region extensions/codex/src/command-account.ts
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
async function readCodexAccountAuthOverview(params) {
	const config = params.ctx.config;
	const store = ensureAuthProfileStore(resolveDefaultAgentDir(config), {
		allowKeychainPrompt: false,
		config
	});
	const { order, explicit: explicitOrder } = resolveDisplayAuthOrder({
		config,
		store
	});
	if (order.length === 0) return;
	const now = Date.now();
	const activeProfileId = resolveActiveProfileId({
		store,
		order,
		explicitOrder,
		config,
		account: params.account,
		limits: params.limits,
		now
	});
	const subscriptionProfileId = order.find((profileId) => isChatGptSubscriptionProfile(store.profiles[profileId]));
	const activeIsSubscription = activeProfileId !== void 0 && isChatGptSubscriptionProfile(store.profiles[activeProfileId]);
	const activeUsage = activeIsSubscription && params.limits.ok ? summarizeCodexAccountUsage(params.limits.value, now) : void 0;
	const subscriptionUsage = subscriptionProfileId && (!activeIsSubscription || subscriptionProfileId !== activeProfileId) ? await readSubscriptionUsage({
		...params,
		config,
		subscriptionProfileId,
		now
	}) : activeUsage;
	if (!params.account.ok && !params.limits.ok && !subscriptionUsage) return;
	const rows = order.map((profileId, index) => buildProfileRow({
		store,
		config,
		profileId,
		activeProfileId,
		activeIndex: activeProfileId ? order.indexOf(activeProfileId) : -1,
		index,
		now,
		usage: profileId === subscriptionProfileId ? subscriptionUsage : void 0
	}));
	const activeRow = rows.find((row) => row.active);
	if (!activeRow) return {
		currentLine: "OpenAI credentials: no working credential",
		orderTitle: "Auth order",
		rows
	};
	const activeIsApiKey = store.profiles[activeRow.profileId]?.type === "api_key";
	const subscriptionLabel = subscriptionProfileId ? formatProfileLabel(subscriptionProfileId, store.profiles[subscriptionProfileId]) : activeIsSubscription ? activeRow.label : void 0;
	const subscriptionUsageLine = formatSubscriptionUsageLine(subscriptionUsage);
	return {
		...activeIsApiKey ? { currentLine: buildApiKeyActiveLine(activeRow, subscriptionUsage) } : {},
		...subscriptionLabel ? { subscriptionLabel } : {},
		...subscriptionUsageLine ? { subscriptionUsage: subscriptionUsageLine } : {},
		orderTitle: "Auth order",
		rows
	};
}
function resolveDisplayAuthOrder(params) {
	const codexOrder = resolveOrder(params.store.order, OPENAI_CODEX_PROVIDER_ID) ?? resolveOrder(params.config?.auth?.order, OPENAI_CODEX_PROVIDER_ID);
	if (codexOrder && codexOrder.length > 0) return {
		order: dedupe(codexOrder),
		explicit: true
	};
	return {
		order: resolveAuthProfileOrder({
			cfg: params.config,
			store: params.store,
			provider: OPENAI_CODEX_PROVIDER_ID
		}),
		explicit: hasExplicitOpenAiAuthOrder(params)
	};
}
function hasExplicitOpenAiAuthOrder(params) {
	const sources = [params.store.order, params.config?.auth?.order];
	for (const source of sources) {
		const codex = resolveOrder(source, OPENAI_CODEX_PROVIDER_ID);
		if (codex && codex.length > 0) return true;
		const openai = resolveOrder(source, OPENAI_PROVIDER_ID);
		if (openai && openai.length > 0) return true;
	}
	return false;
}
function resolveOrder(order, provider) {
	return findNormalizedProviderValue(order, provider);
}
function resolveActiveProfileId(params) {
	const liveProfileId = resolveLiveAccountProfileId({
		account: params.account,
		store: params.store,
		order: params.order
	});
	if (liveProfileId) return liveProfileId;
	if (params.explicitOrder) return params.order.find((profileId) => isActiveProfileCandidate(params, profileId) && resolveAuthProfileEligibility({
		cfg: params.config,
		store: params.store,
		provider: OPENAI_CODEX_PROVIDER_ID,
		profileId,
		now: params.now
	}).eligible);
	const lastGood = [params.store.lastGood?.[OPENAI_PROVIDER_ID], params.store.lastGood?.[OPENAI_CODEX_PROVIDER_ID]].find((profileId) => !!profileId && params.order.includes(profileId) && isActiveProfileCandidate(params, profileId));
	if (lastGood) return lastGood;
	const mostRecent = params.order.map((profileId) => ({
		profileId,
		lastUsed: params.store.usageStats?.[profileId]?.lastUsed ?? 0
	})).filter((entry) => entry.lastUsed > 0 && isActiveProfileCandidate(params, entry.profileId)).toSorted((left, right) => right.lastUsed - left.lastUsed)[0]?.profileId;
	if (mostRecent) return mostRecent;
	if (shouldInferApiKeyActiveFromRateLimitProbe(params.limits)) {
		const apiKeyProfile = params.order.find((profileId) => params.store.profiles[profileId]?.type === "api_key");
		if (apiKeyProfile) return apiKeyProfile;
	}
	return resolveAuthProfileOrder({
		cfg: params.config,
		store: params.store,
		provider: OPENAI_CODEX_PROVIDER_ID
	})[0];
}
function isActiveProfileCandidate(params, profileId) {
	return !isActiveUntil(resolveProfileUnusableUntilForDisplay(params.store, profileId) ?? void 0, params.now);
}
function resolveLiveAccountProfileId(params) {
	if (!params.account.ok || !isJsonObject(params.account.value)) return;
	const account = isJsonObject(params.account.value.account) ? params.account.value.account : params.account.value;
	const type = readString(account, "type")?.toLowerCase();
	if (type === "chatgpt") {
		const email = readString(account, "email")?.toLowerCase();
		const firstSubscription = params.order.find((profileId) => isChatGptSubscriptionProfile(params.store.profiles[profileId]));
		if (!email) return firstSubscription;
		return params.order.find((profileId) => {
			const credential = params.store.profiles[profileId];
			if (!isChatGptSubscriptionProfile(credential)) return false;
			return (credential.email?.trim().toLowerCase() ?? extractEmailFromProfileId(profileId))?.toLowerCase() === email;
		}) ?? firstSubscription;
	}
	if (type === "apikey" || type === "api_key") return params.order.find((profileId) => params.store.profiles[profileId]?.type === "api_key");
}
function shouldInferApiKeyActiveFromRateLimitProbe(limits) {
	return !limits.ok && limits.error.toLowerCase().includes("chatgpt authentication required");
}
async function readSubscriptionUsage(params) {
	const limits = await params.safeCodexControlRequest(params.pluginConfig, CODEX_CONTROL_METHODS.rateLimits, void 0, {
		config: params.config,
		authProfileId: params.subscriptionProfileId,
		isolated: true
	});
	if (!limits.ok) return;
	rememberCodexRateLimits(limits.value);
	return summarizeCodexAccountUsage(limits.value, params.now);
}
function buildProfileRow(params) {
	const credential = params.store.profiles[params.profileId];
	const label = formatProfileLabel(params.profileId, credential);
	const kind = formatProfileKind(credential);
	const active = params.profileId === params.activeProfileId;
	const status = active ? "active now" : params.usage?.blocked ? formatUsageBlockedStatus(params.usage) : describeInactiveProfileStatus({
		store: params.store,
		config: params.config,
		profileId: params.profileId,
		credential,
		now: params.now,
		afterActive: params.activeIndex >= 0 && params.index > params.activeIndex
	});
	return {
		profileId: params.profileId,
		label,
		kind,
		status,
		active,
		...credential?.type === "api_key" && active ? { billingNote: "billed per token" } : {},
		...params.usage?.usageLine ? { usage: params.usage.usageLine } : {}
	};
}
function formatUsageBlockedStatus(usage) {
	return usage.blocked ? "rate-limited" : "available if needed";
}
function describeInactiveProfileStatus(params) {
	const stats = params.store.usageStats?.[params.profileId];
	const blockedUntil = stats?.blockedUntil;
	if (isActiveUntil(blockedUntil, params.now)) return `rate-limited - resets ${formatRelativeReset(blockedUntil, params.now)}`;
	if (isActiveUntil(resolveProfileUnusableUntilForDisplay(params.store, params.profileId) ?? void 0, params.now)) return describeFailureStatus(stats?.disabledReason ?? stats?.cooldownReason, params.credential);
	const eligibility = resolveAuthProfileEligibility({
		cfg: params.config,
		store: params.store,
		provider: OPENAI_CODEX_PROVIDER_ID,
		profileId: params.profileId,
		now: params.now
	});
	if (!eligibility.eligible) return describeEligibilityStatus(eligibility.reasonCode, params.credential);
	return "available if needed";
}
function buildApiKeyActiveLine(activeRow, subscriptionUsage) {
	if (subscriptionUsage?.blocked) {
		const switchBack = subscriptionUsage.blockedResetRelative ? ` · switches back ${subscriptionUsage.blockedResetRelative}` : " · switches back automatically";
		return `Now using: ${activeRow.label} - subscription rate-limited${switchBack}`;
	}
	return `Now using: ${activeRow.label} - subscription unavailable · switches back automatically`;
}
function formatSubscriptionUsageLine(usage) {
	if (!usage) return;
	const parts = usage.usageLine ? [formatUsageLineForDisplay(usage.usageLine)] : [];
	if (usage.blockedResetRelative) parts.push(`Resets ${usage.blockedResetRelative}`);
	return parts.length > 0 ? parts.join(" · ") : void 0;
}
function formatUsageLineForDisplay(value) {
	return value.replace(/^weekly\b/u, "Weekly").replace(/\bshort-term\b/u, "Short-term");
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function isChatGptSubscriptionProfile(credential) {
	return credential?.type === "oauth" || credential?.type === "token";
}
function formatProfileKind(credential) {
	if (!credential) return "credential";
	if (isChatGptSubscriptionProfile(credential)) return "ChatGPT subscription";
	if (credential.type === "api_key") return "API key";
	return "credential";
}
function formatProfileLabel(profileId, credential) {
	const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
	const displayName = credential?.displayName?.trim();
	if (displayName) return credential?.type === "api_key" ? simplifyApiKeyDisplayName(displayName, tail) : displayName;
	const email = credential?.email?.trim() ?? extractEmailFromProfileId(profileId);
	if (email) return email;
	if (credential?.type === "api_key") return tail || "API key";
	return humanizeProfileTail(tail);
}
function simplifyApiKeyDisplayName(value, tail) {
	const stripped = value.replace(/^OpenAI\s+/iu, "").trim();
	if (tail && stripped.toLowerCase() === humanizeApiKeyProfileTail(tail).toLowerCase()) return tail;
	return stripped || value;
}
function humanizeApiKeyProfileTail(tail) {
	const words = splitProfileTail(tail);
	const hasBackup = words.includes("backup");
	return [
		words.filter((word) => word !== "api" && word !== "key" && word !== "backup").map(titleCase).join(" "),
		"API key",
		hasBackup ? "backup" : ""
	].filter(Boolean).join(" ");
}
function humanizeProfileTail(tail) {
	const words = splitProfileTail(tail);
	return words.length > 0 ? words.map(titleCase).join(" ") : tail;
}
function splitProfileTail(tail) {
	return tail.replace(/[_\s]+/gu, "-").split("-").map((word) => word.trim().toLowerCase()).filter(Boolean);
}
function titleCase(value) {
	return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}
function extractEmailFromProfileId(profileId) {
	const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
	return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(tail) ? tail : void 0;
}
function describeFailureStatus(reason, credential) {
	if (reason === "auth" || reason === "auth_permanent" || reason === "session_expired") return credential?.type === "api_key" ? "auth failed - check key" : "sign-in expired";
	if (reason === "billing") return "billing unavailable";
	if (reason === "rate_limit") return "rate-limited";
	return "temporarily unavailable";
}
function describeEligibilityStatus(reason, credential) {
	if (reason === "profile_missing" || reason === "missing_credential") return credential?.type === "api_key" ? "not configured" : "sign-in required";
	if (reason === "expired" || reason === "invalid_expires") return "sign-in expired";
	if (reason === "unresolved_ref") return "credential unavailable";
	if (reason === "provider_mismatch") return "wrong provider";
	if (reason === "mode_mismatch") return "wrong credential type";
	return "unavailable";
}
function isActiveUntil(value, now) {
	return typeof value === "number" && Number.isFinite(value) && value > now;
}
function formatRelativeReset(untilMs, nowMs) {
	const durationMs = Math.max(1e3, untilMs - nowMs);
	const minuteMs = 6e4;
	const hourMs = 60 * minuteMs;
	const dayMs = 24 * hourMs;
	if (durationMs < hourMs) {
		const minutes = Math.ceil(durationMs / minuteMs);
		return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	if (durationMs < dayMs) {
		const hours = Math.ceil(durationMs / hourMs);
		return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	const days = Math.ceil(durationMs / dayMs);
	return `in ${days} ${days === 1 ? "day" : "days"}`;
}
function dedupe(values) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}
//#endregion
//#region extensions/codex/src/command-plugins-management.ts
const POLICY_REFRESH_HINT = "New Codex conversations pick this up automatically. Use /new or /reset to refresh the current one.";
async function handleCodexPluginsSubcommand(ctx, rest, io) {
	const [verb = "list", ...args] = rest;
	const normalized = verb.toLowerCase();
	if (normalized === "list") {
		if (args.length > 0) return { text: "Usage: /codex plugins list" };
		const current = await io.readConfig();
		return { text: formatPluginList(current.plugins ?? {}, { globalEnabled: current.enabled === true }) };
	}
	const target = args[0];
	if (normalized === "enable" || normalized === "disable") {
		if (!target || args.length > 1) return { text: `Usage: /codex plugins ${normalized} <name>` };
		if (!canMutateCodexPlugins(ctx)) return { text: `Only an owner or operator.admin gateway client can run /codex plugins ${normalized}.` };
		const wantEnabled = normalized === "enable";
		if (!((await io.readConfig()).plugins ?? {})[target]) return { text: `Codex sub-plugin '${formatCodexDisplayText(target)}' is not configured. Run '/codex plugins list' to see configured plugins.` };
		await io.mutate((block) => {
			if (wantEnabled) block.enabled = true;
			block.plugins ??= {};
			block.plugins[target] = {
				...block.plugins[target],
				enabled: wantEnabled
			};
		});
		return { text: `${formatCodexDisplayText(target)}: ${wantEnabled ? "enabled" : "disabled"} in openclaw.json. ${POLICY_REFRESH_HINT}` };
	}
	return { text: `Unknown /codex plugins subcommand: ${formatCodexDisplayText(verb)}\n\n${buildPluginsHelp()}` };
}
function canMutateCodexPlugins(ctx) {
	if (ctx.senderIsOwner === true) return true;
	return ctx.gatewayClientScopes?.includes("operator.admin") === true;
}
function buildPluginsHelp() {
	return [
		"Codex sub-plugin management (writes only to ~/.openclaw/openclaw.json, never to ~/.codex/config.toml):",
		"- /codex plugins                  (alias for list)",
		"- /codex plugins list             show all configured Codex sub-plugins",
		"- /codex plugins enable <name>    enable a configured sub-plugin",
		"- /codex plugins disable <name>   disable a configured sub-plugin"
	].join("\n");
}
function formatPluginList(plugins, options = {}) {
	const globalEnabled = options.globalEnabled === true;
	const keys = Object.keys(plugins).toSorted();
	if (keys.length === 0) return "No Codex sub-plugins configured under plugins.entries.codex.config.codexPlugins.plugins";
	const rows = keys.map((key) => {
		const entry = plugins[key] ?? {};
		const state = globalEnabled && entry.enabled !== false ? "ON " : "OFF";
		return {
			displayKey: formatCodexDisplayText(key),
			state,
			pluginName: formatCodexDisplayText(entry.pluginName ?? key),
			marketplace: formatCodexDisplayText(entry.marketplaceName ?? "?")
		};
	});
	const keyW = Math.max(...rows.map((r) => r.displayKey.length));
	const pluginW = Math.max(...rows.map((r) => r.pluginName.length));
	return [
		"Codex sub-plugins in Openclaw config (~/.openclaw/openclaw.json):",
		"",
		...rows.map((r) => `  ${r.state}  ${r.displayKey.padEnd(keyW)}  ${r.pluginName.padEnd(pluginW)}  [${r.marketplace}]`),
		"",
		...globalEnabled ? [] : ["Global codexPlugins.enabled is off; configured sub-plugins are inactive.", ""],
		"New Codex conversations pick up policy changes automatically; /new or /reset to refresh the current one."
	].join("\n");
}
//#endregion
//#region extensions/codex/src/command-rpc.ts
function requestOptions(pluginConfig, limit, config) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	return {
		limit,
		timeoutMs: runtime.requestTimeoutMs,
		startOptions: runtime.start,
		config
	};
}
async function codexControlRequest(pluginConfig, method, requestParams, options = {}) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	return await requestCodexAppServerJson({
		method,
		requestParams,
		timeoutMs: runtime.requestTimeoutMs,
		startOptions: runtime.start,
		config: options.config,
		sessionKey: options.sessionKey,
		sessionId: options.sessionId,
		authProfileId: options.authProfileId,
		agentDir: options.agentDir,
		isolated: options.isolated
	});
}
async function safeCodexControlRequest(pluginConfig, method, requestParams, options = {}) {
	return await safeValue(async () => await codexControlRequest(pluginConfig, method, requestParams, options));
}
async function safeCodexModelList(pluginConfig, limit, config) {
	return await safeValue(async () => await listCodexAppServerModels(requestOptions(pluginConfig, limit, config)));
}
async function readCodexStatusProbes(pluginConfig, config) {
	const [models, account, limits, mcps, skills] = await Promise.all([
		safeCodexModelList(pluginConfig, 20, config),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.account, { refreshToken: false }, { config }),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.rateLimits, void 0, { config }),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, { limit: 100 }, { config }),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}, { config })
	]);
	return {
		models,
		account,
		limits,
		mcps,
		skills
	};
}
async function safeValue(read) {
	try {
		return {
			ok: true,
			value: await read()
		};
	} catch (error) {
		return {
			ok: false,
			error: describeControlFailure(error)
		};
	}
}
//#endregion
//#region extensions/codex/src/command-handlers.ts
const defaultCodexCommandDeps = {
	codexControlRequest,
	listCodexAppServerModels: listAllCodexAppServerModels,
	readCodexStatusProbes,
	readCodexAppServerBinding,
	requestOptions,
	safeCodexControlRequest,
	writeCodexAppServerBinding,
	clearCodexAppServerBinding,
	readCodexComputerUseStatus,
	installCodexComputerUse,
	resolveCodexDefaultWorkspaceDir,
	startCodexConversationThread,
	readCodexConversationActiveTurn,
	setCodexConversationFastMode,
	setCodexConversationModel,
	setCodexConversationPermissions,
	steerCodexConversationTurn,
	stopCodexConversationTurn,
	listCodexCliSessionsOnNode: async () => {
		throw new Error("Codex CLI node sessions require Gateway node runtime.");
	},
	resolveCodexCliSessionForBindingOnNode: async () => {
		throw new Error("Codex CLI node sessions require Gateway node runtime.");
	}
};
const CODEX_DIAGNOSTICS_SOURCE = "openclaw-diagnostics";
const CODEX_DIAGNOSTICS_REASON_MAX_CHARS = 2048;
const CODEX_DIAGNOSTICS_COOLDOWN_MS = 6e4;
const CODEX_DIAGNOSTICS_ERROR_MAX_CHARS = 500;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS = 100;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS = 5 * 6e4;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS = 128;
const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CODEX_NATIVE_EXECUTION_SUBCOMMANDS = new Set([
	"bind",
	"resume",
	"steer",
	"model",
	"fast",
	"permissions",
	"compact",
	"review"
]);
const lastCodexDiagnosticsUploadByThread = /* @__PURE__ */ new Map();
const lastCodexDiagnosticsUploadByScope = /* @__PURE__ */ new Map();
const pendingCodexDiagnosticsConfirmations = /* @__PURE__ */ new Map();
const pendingCodexDiagnosticsConfirmationTokensByScope = /* @__PURE__ */ new Map();
async function handleCodexSubcommand(ctx, options) {
	const deps = {
		...defaultCodexCommandDeps,
		...options.deps
	};
	const [subcommand = "status", ...rest] = splitArgs(ctx.args);
	const normalized = subcommand.toLowerCase();
	if (normalized === "help") return { text: buildHelp() };
	const sandboxBlock = resolveCodexNativeCommandSandboxBlock(ctx, normalized, rest);
	if (sandboxBlock) return { text: sandboxBlock };
	if (normalized === "plugins") {
		if (!deps.codexPluginsManagementIo) return { text: "Codex sub-plugin management is not wired up (codexPluginsManagementIo dep is undefined). Edit ~/.openclaw/openclaw.json or use `openclaw config patch` until the runtime exposes the IO." };
		return await handleCodexPluginsSubcommand(ctx, rest, deps.codexPluginsManagementIo);
	}
	if (normalized === "status") {
		if (rest.length > 0) return { text: "Usage: /codex status" };
		return { text: formatCodexStatus(await deps.readCodexStatusProbes(options.pluginConfig, ctx.config)) };
	}
	if (normalized === "models") {
		if (rest.length > 0) return { text: "Usage: /codex models" };
		return { text: formatModels(await deps.listCodexAppServerModels(deps.requestOptions(options.pluginConfig, 100, ctx.config))) };
	}
	if (normalized === "threads") return { text: await buildThreads(deps, options.pluginConfig, rest.join(" ")) };
	if (normalized === "sessions") return { text: await buildCodexCliSessions(deps, rest) };
	if (normalized === "resume") return { text: await resumeThread(deps, ctx, options.pluginConfig, rest) };
	if (normalized === "bind") return await bindConversation(deps, ctx, options.pluginConfig, rest);
	if (normalized === "detach" || normalized === "unbind") {
		if (rest.length > 0) return { text: "Usage: /codex detach" };
		return { text: await detachConversation(deps, ctx) };
	}
	if (normalized === "binding") {
		if (rest.length > 0) return { text: "Usage: /codex binding" };
		return { text: await describeConversationBinding(deps, ctx) };
	}
	if (normalized === "stop") {
		if (rest.length > 0) return { text: "Usage: /codex stop" };
		return { text: await stopConversationTurn(deps, ctx, options.pluginConfig) };
	}
	if (normalized === "steer") return { text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")) };
	if (normalized === "model") return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest) };
	if (normalized === "fast") return { text: await setConversationFastMode(deps, ctx, options.pluginConfig, rest) };
	if (normalized === "permissions") return { text: await setConversationPermissions(deps, ctx, options.pluginConfig, rest) };
	if (normalized === "compact") return { text: await startThreadAction(deps, ctx, options.pluginConfig, CODEX_CONTROL_METHODS.compact, "compaction", rest) };
	if (normalized === "review") return { text: await startThreadAction(deps, ctx, options.pluginConfig, CODEX_CONTROL_METHODS.review, "review", rest) };
	if (normalized === "diagnostics") return await handleCodexDiagnosticsFeedback(deps, ctx, options.pluginConfig, rest.join(" "), "/codex diagnostics");
	if (normalized === "computer-use" || normalized === "computeruse") return { text: await handleComputerUseCommand(deps, options.pluginConfig, rest) };
	if (normalized === "mcp") {
		if (rest.length > 0) return { text: "Usage: /codex mcp" };
		return { text: formatList(await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, { limit: 100 }), "MCP servers") };
	}
	if (normalized === "skills") {
		if (rest.length > 0) return { text: "Usage: /codex skills" };
		return { text: formatList(await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}), "Codex skills") };
	}
	if (normalized === "account") {
		if (rest.length > 0) return { text: "Usage: /codex account" };
		const [account, limits] = await Promise.all([deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.account, { refreshToken: false }), deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.rateLimits, void 0)]);
		if (limits.ok) rememberCodexRateLimits(limits.value);
		return { text: formatAccount(account, limits, await readCodexAccountAuthOverview({
			ctx,
			pluginConfig: options.pluginConfig,
			safeCodexControlRequest: deps.safeCodexControlRequest,
			account,
			limits
		})) };
	}
	return { text: `Unknown Codex command: ${formatCodexDisplayText(subcommand)}\n\n${buildHelp()}` };
}
function resolveCodexNativeCommandSandboxBlock(ctx, subcommand, args) {
	if (!CODEX_NATIVE_EXECUTION_SUBCOMMANDS.has(subcommand)) return;
	if (returnsBeforeNativeCodexExecution(subcommand, args)) return;
	if (isCodexCliNodeResumeBind(subcommand, args)) return resolveCodexNativeSandboxBlock({
		config: ctx.config,
		sessionKey: ctx.sessionKey,
		sessionId: ctx.sessionId,
		surface: `/${["codex", subcommand].join(" ")}`
	});
	return resolveCodexNativeExecutionBlock({
		config: ctx.config,
		sessionKey: ctx.sessionKey,
		sessionId: ctx.sessionId,
		surface: `/${["codex", subcommand].join(" ")}`
	});
}
function returnsBeforeNativeCodexExecution(subcommand, args) {
	switch (subcommand) {
		case "bind": return parseBindArgs([...args]).help === true;
		case "resume": return returnsBeforeNativeCodexResume(args);
		case "steer": return args.join(" ").trim() === "";
		case "model": return args.length === 0 || args.length > 1;
		case "fast": return args.length === 0 || args.length > 1 || parseCodexFastModeArg(args[0]) === void 0;
		case "permissions": return args.length === 0 || args.length > 1 || parseCodexPermissionsModeArg(args[0]) === void 0;
		case "compact":
		case "review":
		case "stop": return args.length > 0;
		default: return false;
	}
}
function isCodexCliNodeResumeBind(subcommand, args) {
	if (subcommand !== "resume") return false;
	const parsed = parseResumeArgs([...args]);
	return Boolean(parsed.host && parsed.threadId && parsed.bindHere === true && !parsed.help);
}
function returnsBeforeNativeCodexResume(args) {
	const parsed = parseResumeArgs([...args]);
	const normalizedThreadId = parsed.threadId?.trim();
	if (parsed.help) return true;
	if (parsed.host) return !normalizedThreadId || parsed.bindHere !== true;
	return !normalizedThreadId || args.length !== 1;
}
async function handleComputerUseCommand(deps, pluginConfig, args) {
	const parsed = parseComputerUseArgs(args);
	if (parsed.help) return ["Usage: /codex computer-use [status|install] [--source <marketplace-source>] [--marketplace-path <path>] [--marketplace <name>]", "Checks or installs the configured Codex Computer Use plugin through app-server."].join("\n");
	const params = {
		pluginConfig,
		forceEnable: parsed.action === "install" || parsed.hasOverrides,
		...Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}
	};
	if (parsed.action === "install") return formatComputerUseStatus(await deps.installCodexComputerUse(params));
	return formatComputerUseStatus(await deps.readCodexComputerUseStatus(params));
}
async function bindConversation(deps, ctx, pluginConfig, args) {
	const parsed = parseBindArgs(args);
	if (parsed.help) return { text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]" };
	if (!ctx.sessionFile) return { text: "Cannot bind Codex because this command did not include an OpenClaw session file." };
	const scope = resolveCodexConversationControlScope(ctx);
	const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
	const authProfileId = (await deps.readCodexAppServerBinding(ctx.sessionFile, {
		agentDir: scope.agentDir,
		config: ctx.config
	}))?.authProfileId;
	const startParams = {
		pluginConfig,
		config: ctx.config,
		sessionFile: ctx.sessionFile,
		workspaceDir,
		agentDir: scope.agentDir,
		threadId: parsed.threadId,
		model: parsed.model,
		modelProvider: parsed.provider
	};
	if (authProfileId) startParams.authProfileId = authProfileId;
	const data = await deps.startCodexConversationThread(startParams);
	const threadId = (await deps.readCodexAppServerBinding(ctx.sessionFile, {
		agentDir: scope.agentDir,
		config: ctx.config
	}))?.threadId ?? parsed.threadId ?? "new thread";
	const summary = `Codex app-server thread ${formatCodexDisplayText(threadId)} in ${formatCodexDisplayText(workspaceDir)}`;
	let request;
	try {
		request = await ctx.requestConversationBinding({
			summary,
			detachHint: "/codex detach",
			data
		});
	} catch (error) {
		await deps.clearCodexAppServerBinding(ctx.sessionFile);
		throw error;
	}
	if (request.status === "bound") return { text: `Bound this conversation to Codex thread ${formatCodexDisplayText(threadId)} in ${formatCodexDisplayText(workspaceDir)}.` };
	if (request.status === "pending") return request.reply;
	await deps.clearCodexAppServerBinding(ctx.sessionFile);
	return { text: formatCodexDisplayText(request.message) };
}
async function detachConversation(deps, ctx) {
	const data = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
	const detached = await ctx.detachConversationBinding();
	if (data?.kind === "codex-app-server-session") await deps.clearCodexAppServerBinding(data.sessionFile);
	else if (ctx.sessionFile) await deps.clearCodexAppServerBinding(ctx.sessionFile);
	return detached.removed ? "Detached this conversation from Codex." : "No Codex conversation binding was attached.";
}
async function describeConversationBinding(deps, ctx) {
	const current = await ctx.getCurrentConversationBinding();
	const data = readCodexConversationBindingData(current);
	if (!current || !data) return "No Codex conversation binding is attached.";
	if (data.kind === "codex-cli-node-session") return [
		"Codex conversation binding:",
		"- Mode: Codex CLI node session",
		`- Node: ${formatCodexDisplayText(data.nodeId)}`,
		`- Session: ${formatCodexDisplayText(data.sessionId)}`,
		`- Workspace: ${formatCodexDisplayText(data.cwd ?? "unknown")}`,
		"- Active run: not tracked"
	].join("\n");
	const threadBinding = await deps.readCodexAppServerBinding(data.sessionFile, {
		agentDir: data.agentDir,
		config: ctx.config
	});
	const active = deps.readCodexConversationActiveTurn(data.sessionFile);
	return [
		"Codex conversation binding:",
		`- Thread: ${formatCodexDisplayText(threadBinding?.threadId ?? "unknown")}`,
		`- Workspace: ${formatCodexDisplayText(data.workspaceDir)}`,
		`- Model: ${formatCodexDisplayText(threadBinding?.model ?? "default")}`,
		`- Fast: ${isCodexFastServiceTier(threadBinding?.serviceTier) ? "on" : "off"}`,
		`- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
		`- Active run: ${formatCodexDisplayText(active ? active.turnId : "none")}`,
		`- Session: ${formatCodexDisplayText(data.sessionFile)}`
	].join("\n");
}
async function buildThreads(deps, pluginConfig, filter) {
	return formatThreads(await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, {
		limit: 10,
		...filter.trim() ? { searchTerm: filter.trim() } : {}
	}));
}
async function buildCodexCliSessions(deps, args) {
	const parsed = parseCodexCliSessionsArgs(args);
	if (parsed.help || !parsed.host) return "Usage: /codex sessions --host <node> [filter] [--limit <n>]";
	return formatCodexCliSessions(await deps.listCodexCliSessionsOnNode({
		requestedNode: parsed.host,
		filter: parsed.filter,
		limit: parsed.limit
	}));
}
async function resumeThread(deps, ctx, pluginConfig, args) {
	const parsed = parseResumeArgs(args);
	const normalizedThreadId = parsed.threadId?.trim();
	if (parsed.help) return args.includes("--help") || args.includes("-h") || parsed.host ? "Usage: /codex resume <thread-id>\nUsage: /codex resume <session-id> --host <node> --bind here" : "Usage: /codex resume <thread-id>";
	if (parsed.host) return await bindCodexCliNodeSession(deps, ctx, parsed);
	if (!normalizedThreadId || args.length !== 1) return "Usage: /codex resume <thread-id>";
	if (!ctx.sessionFile) return "Cannot attach a Codex thread because this command did not include an OpenClaw session file.";
	const response = await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.resumeThread, {
		threadId: normalizedThreadId,
		persistExtendedHistory: true
	});
	const thread = isJsonObject(response) && isJsonObject(response.thread) ? response.thread : {};
	const effectiveThreadId = readString$1(thread, "id") ?? normalizedThreadId;
	await deps.writeCodexAppServerBinding(ctx.sessionFile, {
		threadId: effectiveThreadId,
		cwd: readString$1(thread, "cwd") ?? "",
		model: isJsonObject(response) ? readString$1(response, "model") : void 0,
		modelProvider: isJsonObject(response) ? readString$1(response, "modelProvider") : void 0
	});
	return `Attached this OpenClaw session to Codex thread ${formatCodexDisplayText(effectiveThreadId)}.`;
}
async function bindCodexCliNodeSession(deps, ctx, parsed) {
	if (!parsed.threadId || !parsed.host || parsed.bindHere !== true) return "Usage: /codex resume <session-id> --host <node> --bind here";
	const resolved = await deps.resolveCodexCliSessionForBindingOnNode({
		requestedNode: parsed.host,
		sessionId: parsed.threadId
	});
	if (!resolved.session) return `No Codex CLI session ${formatCodexDisplayText(parsed.threadId)} was found on ${formatCodexDisplayText(parsed.host)}.`;
	const nodeId = resolved.node.nodeId;
	if (!nodeId) return "Cannot bind Codex CLI session because the selected node did not include a node id.";
	const data = createCodexCliNodeConversationBindingData({
		nodeId,
		sessionId: parsed.threadId,
		cwd: resolved.session?.cwd
	});
	const summary = `Codex CLI session ${formatCodexDisplayText(parsed.threadId)} on ${formatCodexDisplayText(nodeId)}`;
	const request = await ctx.requestConversationBinding({
		summary,
		detachHint: "/codex detach",
		data
	});
	if (request.status === "bound") return `Bound this conversation to Codex CLI session ${formatCodexDisplayText(parsed.threadId)} on ${formatCodexDisplayText(nodeId)}.`;
	if (request.status === "pending") return request.reply.text ?? "Codex CLI session binding is pending approval.";
	return formatCodexDisplayText(request.message);
}
async function stopConversationTurn(deps, ctx, pluginConfig) {
	const target = await resolveControlTarget(ctx);
	if (!target) return "Cannot stop Codex because this command did not include an OpenClaw session file.";
	return (await deps.stopCodexConversationTurn({
		sessionFile: target.sessionFile,
		pluginConfig,
		agentDir: target.agentDir,
		config: ctx.config
	})).message;
}
async function steerConversationTurn(deps, ctx, pluginConfig, message) {
	const target = await resolveControlTarget(ctx);
	if (!target) return "Cannot steer Codex because this command did not include an OpenClaw session file.";
	return (await deps.steerCodexConversationTurn({
		sessionFile: target.sessionFile,
		pluginConfig,
		message,
		agentDir: target.agentDir,
		config: ctx.config
	})).message;
}
async function setConversationModel(deps, ctx, pluginConfig, args) {
	if (args.length > 1) return "Usage: /codex model <model>";
	const target = await resolveControlTarget(ctx);
	if (!target) return "Cannot set Codex model because this command did not include an OpenClaw session file.";
	const [model = ""] = args;
	const normalized = model.trim();
	if (!normalized) {
		const binding = await deps.readCodexAppServerBinding(target.sessionFile, {
			agentDir: target.agentDir,
			config: ctx.config
		});
		return binding?.model ? `Codex model: ${formatCodexDisplayText(binding.model)}` : "Usage: /codex model <model>";
	}
	return await deps.setCodexConversationModel({
		sessionFile: target.sessionFile,
		pluginConfig,
		model: normalized,
		agentDir: target.agentDir,
		config: ctx.config
	});
}
async function setConversationFastMode(deps, ctx, pluginConfig, args) {
	if (args.length > 1) return "Usage: /codex fast [on|off|status]";
	const target = await resolveControlTarget(ctx);
	if (!target) return "Cannot set Codex fast mode because this command did not include an OpenClaw session file.";
	const value = args[0];
	const parsed = parseCodexFastModeArg(value);
	if (value && parsed == null && value.trim().toLowerCase() !== "status") return "Usage: /codex fast [on|off|status]";
	return await deps.setCodexConversationFastMode({
		sessionFile: target.sessionFile,
		pluginConfig,
		enabled: parsed,
		agentDir: target.agentDir,
		config: ctx.config
	});
}
async function setConversationPermissions(deps, ctx, pluginConfig, args) {
	if (args.length > 1) return "Usage: /codex permissions [default|yolo|status]";
	const target = await resolveControlTarget(ctx);
	if (!target) return "Cannot set Codex permissions because this command did not include an OpenClaw session file.";
	const value = args[0];
	const parsed = parseCodexPermissionsModeArg(value);
	if (value && !parsed && value.trim().toLowerCase() !== "status") return "Usage: /codex permissions [default|yolo|status]";
	return await deps.setCodexConversationPermissions({
		sessionFile: target.sessionFile,
		pluginConfig,
		mode: parsed,
		agentDir: target.agentDir,
		config: ctx.config
	});
}
async function resolveControlTarget(ctx) {
	const data = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
	const scope = resolveCodexConversationControlScope(ctx);
	if (data?.kind === "codex-app-server-session") return {
		sessionFile: data.sessionFile,
		agentDir: data.agentDir ?? scope.agentDir
	};
	return ctx.sessionFile ? {
		sessionFile: ctx.sessionFile,
		agentDir: scope.agentDir
	} : void 0;
}
async function resolveControlSessionFile(ctx) {
	return (await resolveControlTarget(ctx))?.sessionFile;
}
function resolveCodexConversationControlScope(ctx) {
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: ctx.sessionKey,
		config: ctx.config
	});
	return { agentDir: resolveAgentDir(ctx.config, sessionAgentId) };
}
async function handleCodexDiagnosticsFeedback(deps, ctx, pluginConfig, args, commandPrefix) {
	if (ctx.senderIsOwner !== true) return { text: "Only an owner can send Codex diagnostics." };
	const parsed = parseDiagnosticsArgs(args);
	if (parsed.action === "usage") return { text: formatDiagnosticsUsage(commandPrefix) };
	if (parsed.action === "confirm") return { text: await confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, parsed.token) };
	if (parsed.action === "cancel") return { text: cancelCodexDiagnosticsFeedback(ctx, parsed.token) };
	if (ctx.diagnosticsUploadApproved === true) return { text: await sendCodexDiagnosticsFeedbackForContext(deps, ctx, pluginConfig, parsed.note) };
	if (ctx.diagnosticsPreviewOnly === true) return { text: await previewCodexDiagnosticsFeedbackApproval(deps, ctx, parsed.note) };
	return await requestCodexDiagnosticsFeedbackApproval(deps, ctx, parsed.note, commandPrefix);
}
async function requestCodexDiagnosticsFeedbackApproval(deps, ctx, note, commandPrefix) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return { text: "Cannot send Codex diagnostics because this command did not include an OpenClaw session file." };
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return { text: ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n") };
	const now = Date.now();
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
	if (cooldownMessage) return { text: cooldownMessage };
	if (!ctx.senderId) return { text: "Cannot send Codex diagnostics because this command did not include a sender identity." };
	const reason = normalizeDiagnosticsReason(note);
	const token = createCodexDiagnosticsConfirmation({
		targets,
		note: reason,
		senderId: ctx.senderId,
		channel: ctx.channel,
		scopeKey: readCodexDiagnosticsCooldownScope(ctx),
		privateRouted: ctx.diagnosticsPrivateRouted === true,
		...readCodexDiagnosticsConfirmationScope(ctx),
		now
	});
	const confirmCommand = `${commandPrefix} confirm ${token}`;
	const cancelCommand = `${commandPrefix} cancel ${token}`;
	const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : void 0;
	return {
		text: [
			targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
			`Codex diagnostics can send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
			"Codex sessions:",
			...formatCodexDiagnosticsTargetLines(targets),
			...displayReason ? [`Note: ${displayReason}`] : [],
			"Included: Codex logs and spawned Codex subthreads when available.",
			`To send: ${confirmCommand}`,
			`To cancel: ${cancelCommand}`,
			"This request expires in 5 minutes."
		].join("\n"),
		interactive: { blocks: [{
			type: "buttons",
			buttons: [{
				label: "Send diagnostics",
				value: confirmCommand,
				style: "danger"
			}, {
				label: "Cancel",
				value: cancelCommand,
				style: "secondary"
			}]
		}] }
	};
}
async function previewCodexDiagnosticsFeedbackApproval(deps, ctx, note) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, Date.now(), { includeThreadId: false });
	if (cooldownMessage) return cooldownMessage;
	const reason = normalizeDiagnosticsReason(note);
	const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : void 0;
	return [
		targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
		`Approving diagnostics will also send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
		"The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
		...displayReason ? [`Note: ${displayReason}`] : [],
		"Included: Codex logs and spawned Codex subthreads when available."
	].join("\n");
}
async function confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, token) {
	const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
	if (!pending) return "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.";
	if (!pending.senderId || !ctx.senderId) return "Cannot confirm Codex diagnostics because this command did not include the original sender identity.";
	if (pending.senderId !== ctx.senderId) return "Only the user who requested these Codex diagnostics can confirm the upload.";
	if (pending.channel !== ctx.channel) return "This Codex diagnostics confirmation belongs to a different channel.";
	const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
	if (scopeMismatch) return scopeMismatch.confirmMessage;
	deletePendingCodexDiagnosticsConfirmation(token);
	if (!pending.privateRouted && !await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const currentTargets = pending.privateRouted ? await resolvePendingCodexDiagnosticsTargets(deps, pending.targets) : await resolveCodexDiagnosticsTargets(deps, ctx);
	if (!codexDiagnosticsTargetsMatch(pending.targets, currentTargets)) return "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.";
	return await sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, pending.note ?? "", pending.targets);
}
function cancelCodexDiagnosticsFeedback(ctx, token) {
	const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
	if (!pending) return "No pending Codex diagnostics confirmation was found.";
	if (!pending.senderId || !ctx.senderId) return "Cannot cancel Codex diagnostics because this command did not include the original sender identity.";
	if (pending.senderId !== ctx.senderId) return "Only the user who requested these Codex diagnostics can cancel the upload.";
	if (pending.channel !== ctx.channel) return "This Codex diagnostics confirmation belongs to a different channel.";
	const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
	if (scopeMismatch) return scopeMismatch.cancelMessage;
	deletePendingCodexDiagnosticsConfirmation(token);
	return [
		"Codex diagnostics upload canceled.",
		"Codex sessions:",
		...formatCodexDiagnosticsTargetLines(pending.targets)
	].join("\n");
}
async function sendCodexDiagnosticsFeedbackForContext(deps, ctx, pluginConfig, note) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	return await sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, note, targets);
}
async function sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, note, targets) {
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	const now = Date.now();
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
	if (cooldownMessage) return cooldownMessage;
	const reason = normalizeDiagnosticsReason(note);
	const sent = [];
	const failed = [];
	for (const target of targets) {
		const response = await deps.safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.feedback, {
			classification: "bug",
			threadId: target.threadId,
			includeLogs: true,
			tags: buildDiagnosticsTags(ctx),
			...reason ? { reason } : {}
		});
		if (!response.ok) {
			failed.push({
				target,
				error: response.error
			});
			continue;
		}
		const responseThreadId = isJsonObject(response.value) ? readString$1(response.value, "threadId") : void 0;
		sent.push({
			...target,
			threadId: responseThreadId ?? target.threadId
		});
		recordCodexDiagnosticsUpload(target.threadId, ctx, now);
	}
	return formatCodexDiagnosticsUploadResult(sent, failed);
}
async function hasAnyCodexDiagnosticsSessionFile(ctx) {
	if (await resolveControlSessionFile(ctx)) return true;
	return (ctx.diagnosticsSessions ?? []).some((session) => Boolean(session.sessionFile));
}
async function resolveCodexDiagnosticsTargets(deps, ctx) {
	const activeSessionFile = await resolveControlSessionFile(ctx);
	const candidates = [];
	if (activeSessionFile) candidates.push({
		threadId: "",
		sessionFile: activeSessionFile,
		sessionKey: ctx.sessionKey,
		sessionId: ctx.sessionId,
		channel: ctx.channel,
		channelId: ctx.channelId,
		accountId: ctx.accountId,
		messageThreadId: ctx.messageThreadId,
		threadParentId: ctx.threadParentId
	});
	for (const session of ctx.diagnosticsSessions ?? []) {
		if (!session.sessionFile) continue;
		candidates.push({
			threadId: "",
			sessionFile: session.sessionFile,
			sessionKey: session.sessionKey,
			sessionId: session.sessionId,
			channel: session.channel,
			channelId: session.channelId,
			accountId: session.accountId,
			messageThreadId: session.messageThreadId,
			threadParentId: session.threadParentId
		});
	}
	const seenSessionFiles = /* @__PURE__ */ new Set();
	const seenThreadIds = /* @__PURE__ */ new Set();
	const targets = [];
	for (const candidate of candidates) {
		if (seenSessionFiles.has(candidate.sessionFile)) continue;
		seenSessionFiles.add(candidate.sessionFile);
		const binding = await deps.readCodexAppServerBinding(candidate.sessionFile);
		if (!binding?.threadId || seenThreadIds.has(binding.threadId)) continue;
		seenThreadIds.add(binding.threadId);
		targets.push({
			...candidate,
			threadId: binding.threadId
		});
	}
	return targets;
}
async function resolvePendingCodexDiagnosticsTargets(deps, targets) {
	const resolved = [];
	for (const target of targets) {
		const binding = await deps.readCodexAppServerBinding(target.sessionFile);
		if (!binding?.threadId) continue;
		resolved.push({
			...target,
			threadId: binding.threadId
		});
	}
	return resolved;
}
function codexDiagnosticsTargetsMatch(expected, actual) {
	const expectedThreadIds = expected.map((target) => target.threadId).toSorted();
	const actualThreadIds = actual.map((target) => target.threadId).toSorted();
	return expectedThreadIds.length === actualThreadIds.length && expectedThreadIds.every((threadId, index) => threadId === actualThreadIds[index]);
}
function formatCodexDiagnosticsUploadResult(sent, failed) {
	const lines = [];
	if (sent.length > 0) {
		lines.push("Codex diagnostics sent to OpenAI servers:");
		lines.push(...formatCodexDiagnosticsTargetLines(sent));
		lines.push("Included Codex logs and spawned Codex subthreads when available.");
	}
	if (failed.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Could not send Codex diagnostics:");
		lines.push(...failed.map(({ target, error }) => `${formatCodexDiagnosticsTargetLine(target)}: ${formatCodexErrorForDisplay(error)}`));
		lines.push("Inspect locally:");
		lines.push(...failed.map(({ target }) => `- ${formatCodexResumeCommandForDisplay(target.threadId)}`));
	}
	return lines.join("\n");
}
function formatCodexDiagnosticsTargetLines(targets) {
	return targets.flatMap((target, index) => {
		const lines = formatCodexDiagnosticsTargetBlock(target, index);
		return index < targets.length - 1 ? [...lines, ""] : lines;
	});
}
function formatCodexDiagnosticsTargetBlock(target, index) {
	const lines = [`Session ${index + 1}`];
	if (target.channel) lines.push(`Channel: ${formatCodexValueForDisplay(target.channel)}`);
	if (target.sessionKey) lines.push(`OpenClaw session key: ${formatCodexCopyableValueForDisplay(target.sessionKey)}`);
	if (target.sessionId) lines.push(`OpenClaw session id: ${formatCodexCopyableValueForDisplay(target.sessionId)}`);
	lines.push(`Codex thread id: ${formatCodexCopyableValueForDisplay(target.threadId)}`);
	lines.push(`Inspect locally: ${formatCodexResumeCommandForDisplay(target.threadId)}`);
	return lines;
}
function formatCodexDiagnosticsTargetLine(target) {
	const parts = [];
	if (target.channel) parts.push(`channel ${formatCodexValueForDisplay(target.channel)}`);
	const sessionLabel = target.sessionId || target.sessionKey;
	if (sessionLabel) parts.push(`OpenClaw session ${formatCodexValueForDisplay(sessionLabel)}`);
	parts.push(`Codex thread ${formatCodexThreadIdForDisplay(target.threadId)}`);
	return `- ${parts.join(", ")}`;
}
function normalizeDiagnosticsReason(note) {
	const normalized = normalizeOptionalString(note);
	return normalized ? normalized.slice(0, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : void 0;
}
function parseDiagnosticsArgs(args) {
	const [action, token, ...extra] = splitArgs(args);
	const normalizedAction = action?.toLowerCase();
	if ((normalizedAction === "confirm" || normalizedAction === "--confirm") && token && extra.length === 0) return {
		action: "confirm",
		token
	};
	if ((normalizedAction === "cancel" || normalizedAction === "--cancel") && token && extra.length === 0) return {
		action: "cancel",
		token
	};
	if (normalizedAction === "confirm" || normalizedAction === "--confirm" || normalizedAction === "cancel" || normalizedAction === "--cancel") return { action: "usage" };
	return {
		action: "request",
		note: args
	};
}
function formatDiagnosticsUsage(commandPrefix) {
	return [
		`Usage: ${commandPrefix} [note]`,
		`Usage: ${commandPrefix} confirm <token>`,
		`Usage: ${commandPrefix} cancel <token>`
	].join("\n");
}
function createCodexDiagnosticsConfirmation(params) {
	prunePendingCodexDiagnosticsConfirmations(params.now);
	if (!pendingCodexDiagnosticsConfirmationTokensByScope.has(params.scopeKey) && pendingCodexDiagnosticsConfirmationTokensByScope.size >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES) {
		const oldestScopeKey = pendingCodexDiagnosticsConfirmationTokensByScope.keys().next().value;
		if (typeof oldestScopeKey === "string") deletePendingCodexDiagnosticsConfirmationScope(oldestScopeKey);
	}
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(params.scopeKey) ?? [];
	while (scopeTokens.length >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE) {
		const oldestToken = scopeTokens.shift();
		if (!oldestToken) break;
		pendingCodexDiagnosticsConfirmations.delete(oldestToken);
	}
	const token = crypto.randomBytes(6).toString("hex");
	scopeTokens.push(token);
	pendingCodexDiagnosticsConfirmationTokensByScope.set(params.scopeKey, scopeTokens);
	pendingCodexDiagnosticsConfirmations.set(token, {
		token,
		targets: params.targets,
		note: params.note,
		senderId: params.senderId,
		channel: params.channel,
		accountId: params.accountId,
		channelId: params.channelId,
		messageThreadId: params.messageThreadId,
		threadParentId: params.threadParentId,
		sessionKey: params.sessionKey,
		scopeKey: params.scopeKey,
		...params.privateRouted === void 0 ? {} : { privateRouted: params.privateRouted },
		createdAt: params.now
	});
	return token;
}
function readCodexDiagnosticsConfirmationScope(ctx) {
	return {
		accountId: normalizeCodexDiagnosticsScopeField(ctx.accountId),
		channelId: normalizeCodexDiagnosticsScopeField(ctx.channelId),
		messageThreadId: typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number" ? normalizeCodexDiagnosticsScopeField(String(ctx.messageThreadId)) : void 0,
		threadParentId: normalizeCodexDiagnosticsScopeField(ctx.threadParentId),
		sessionKey: normalizeCodexDiagnosticsScopeField(ctx.sessionKey)
	};
}
function readCodexDiagnosticsScopeMismatch(pending, ctx) {
	const current = readCodexDiagnosticsConfirmationScope(ctx);
	if (pending.accountId !== current.accountId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different account.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different account."
	};
	if (pending.privateRouted) return;
	if (pending.channelId !== current.channelId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different channel instance.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different channel instance."
	};
	if (pending.messageThreadId !== current.messageThreadId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different thread.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different thread."
	};
	if (pending.threadParentId !== current.threadParentId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different parent thread."
	};
	if (pending.sessionKey !== current.sessionKey) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different session.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different session."
	};
}
function readPendingCodexDiagnosticsConfirmation(token, now) {
	prunePendingCodexDiagnosticsConfirmations(now);
	return pendingCodexDiagnosticsConfirmations.get(token);
}
function prunePendingCodexDiagnosticsConfirmations(now) {
	for (const [token, pending] of pendingCodexDiagnosticsConfirmations) if (now - pending.createdAt >= CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS) deletePendingCodexDiagnosticsConfirmation(token);
}
function deletePendingCodexDiagnosticsConfirmation(token) {
	const pending = pendingCodexDiagnosticsConfirmations.get(token);
	pendingCodexDiagnosticsConfirmations.delete(token);
	if (!pending) return;
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(pending.scopeKey);
	if (!scopeTokens) return;
	const tokenIndex = scopeTokens.indexOf(token);
	if (tokenIndex >= 0) scopeTokens.splice(tokenIndex, 1);
	if (scopeTokens.length === 0) pendingCodexDiagnosticsConfirmationTokensByScope.delete(pending.scopeKey);
}
function deletePendingCodexDiagnosticsConfirmationScope(scopeKey) {
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(scopeKey) ?? [];
	for (const token of scopeTokens) pendingCodexDiagnosticsConfirmations.delete(token);
	pendingCodexDiagnosticsConfirmationTokensByScope.delete(scopeKey);
}
function buildDiagnosticsTags(ctx) {
	const tags = { source: CODEX_DIAGNOSTICS_SOURCE };
	addTag(tags, "channel", ctx.channel);
	return tags;
}
function addTag(tags, key, value) {
	if (typeof value === "string" && value.trim()) tags[key] = value.trim();
}
function formatCodexThreadIdForDisplay(threadId) {
	return escapeCodexChatText(formatCodexTextForDisplay(threadId));
}
function formatCodexValueForDisplay(value) {
	return escapeCodexChatText(formatCodexTextForDisplay(value));
}
function formatCodexCopyableValueForDisplay(value) {
	const safe = formatCodexTextForDisplay(value);
	if (CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) return `\`${safe}\``;
	return escapeCodexChatText(safe);
}
function formatCodexTextForDisplay(value) {
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
	}
	safe = safe.trim();
	return safe || "<unknown>";
}
function escapeCodexChatText(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("@", "＠").replaceAll("`", "｀").replaceAll("[", "［").replaceAll("]", "］").replaceAll("(", "（").replaceAll(")", "）").replaceAll("*", "∗").replaceAll("_", "＿").replaceAll("~", "～").replaceAll("|", "｜");
}
function readCodexDiagnosticsCooldownMs(threadId, now) {
	const lastSentAt = lastCodexDiagnosticsUploadByThread.get(threadId);
	if (!lastSentAt) return 0;
	const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
	if (remainingMs === 0) lastCodexDiagnosticsUploadByThread.delete(threadId);
	return remainingMs;
}
function readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now, options = {}) {
	for (const target of targets) {
		const cooldownMs = readCodexDiagnosticsCooldownMs(target.threadId, now);
		if (cooldownMs > 0) {
			if (options.includeThreadId === false) return `Codex diagnostics were already sent for one of these Codex threads recently. Try again in ${Math.ceil(cooldownMs / 1e3)}s.`;
			return `Codex diagnostics were already sent for thread ${formatCodexThreadIdForDisplay(target.threadId)} recently. Try again in ${Math.ceil(cooldownMs / 1e3)}s.`;
		}
	}
	const scopeCooldownMs = readCodexDiagnosticsScopeCooldownMs(readCodexDiagnosticsCooldownScope(ctx), now);
	if (scopeCooldownMs > 0) return `Codex diagnostics were already sent for this account or channel recently. Try again in ${Math.ceil(scopeCooldownMs / 1e3)}s.`;
}
function readCodexDiagnosticsScopeCooldownMs(scope, now) {
	const lastSentAt = lastCodexDiagnosticsUploadByScope.get(scope);
	if (!lastSentAt) return 0;
	const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
	if (remainingMs === 0) lastCodexDiagnosticsUploadByScope.delete(scope);
	return remainingMs;
}
function recordCodexDiagnosticsUpload(threadId, ctx, now) {
	pruneCodexDiagnosticsCooldowns(now);
	recordBoundedCodexDiagnosticsCooldown(lastCodexDiagnosticsUploadByScope, readCodexDiagnosticsCooldownScope(ctx), CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES, now);
	recordBoundedCodexDiagnosticsCooldown(lastCodexDiagnosticsUploadByThread, threadId, CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS, now);
}
function recordBoundedCodexDiagnosticsCooldown(map, key, maxSize, now) {
	if (!map.has(key)) while (map.size >= maxSize) {
		const oldestKey = map.keys().next().value;
		if (typeof oldestKey !== "string") break;
		map.delete(oldestKey);
	}
	map.set(key, now);
}
function readCodexDiagnosticsCooldownScope(ctx) {
	const scope = readCodexDiagnosticsConfirmationScope(ctx);
	const payload = JSON.stringify({
		accountId: scope.accountId ?? null,
		channelId: scope.channelId ?? null,
		sessionKey: scope.sessionKey ?? null,
		messageThreadId: scope.messageThreadId ?? null,
		threadParentId: scope.threadParentId ?? null,
		senderId: normalizeCodexDiagnosticsScopeField(ctx.senderId) ?? null,
		channel: normalizeCodexDiagnosticsScopeField(ctx.channel) ?? ""
	});
	return crypto.createHash("sha256").update(payload).digest("hex");
}
function pruneCodexDiagnosticsCooldowns(now) {
	pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByThread, now);
	pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByScope, now);
}
function pruneCodexDiagnosticsCooldownMap(map, now) {
	for (const [key, lastSentAt] of map) if (now - lastSentAt >= CODEX_DIAGNOSTICS_COOLDOWN_MS) map.delete(key);
}
function formatCodexErrorForDisplay(error) {
	return escapeCodexChatText(formatCodexTextForDisplay(error).slice(0, CODEX_DIAGNOSTICS_ERROR_MAX_CHARS)) || "unknown error";
}
function formatCodexResumeCommandForDisplay(threadId) {
	const safeThreadId = formatCodexTextForDisplay(threadId);
	if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safeThreadId)) return "run codex resume and paste the thread id shown above";
	return `\`codex resume ${safeThreadId}\``;
}
function isUnsafeDisplayCodePoint(codePoint) {
	return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 173 || codePoint === 1564 || codePoint === 6158 || codePoint >= 8203 && codePoint <= 8207 || codePoint >= 8234 && codePoint <= 8238 || codePoint >= 8288 && codePoint <= 8303 || codePoint === 65279 || codePoint >= 65529 && codePoint <= 65531 || codePoint >= 917504 && codePoint <= 917631;
}
function normalizeCodexDiagnosticsScopeField(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	if (normalized.length <= CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS) return normalized;
	return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}
async function startThreadAction(deps, ctx, pluginConfig, method, label, args) {
	if (args.length > 0) return `Usage: /codex ${label === "compaction" ? "compact" : label}`;
	const target = await resolveControlTarget(ctx);
	if (!target) return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
	const binding = await deps.readCodexAppServerBinding(target.sessionFile, {
		agentDir: target.agentDir,
		config: ctx.config
	});
	if (!binding?.threadId) return `No Codex thread is attached to this OpenClaw session yet.`;
	if (method === CODEX_CONTROL_METHODS.review) await deps.codexControlRequest(pluginConfig, method, {
		threadId: binding.threadId,
		target: { type: "uncommittedChanges" }
	}, {
		agentDir: target.agentDir,
		authProfileId: binding.authProfileId,
		config: ctx.config
	});
	else await deps.codexControlRequest(pluginConfig, method, { threadId: binding.threadId }, {
		agentDir: target.agentDir,
		authProfileId: binding.authProfileId,
		config: ctx.config
	});
	return `Started Codex ${label} for thread ${formatCodexDisplayText(binding.threadId)}.`;
}
function splitArgs(value) {
	const input = value ?? "";
	const args = [];
	let current = "";
	let quote;
	let escaping = false;
	let tokenStarted = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			tokenStarted = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			tokenStarted = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = void 0;
			else current += char;
			tokenStarted = true;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}
		current += char;
		tokenStarted = true;
	}
	if (escaping) current += "\\";
	if (tokenStarted) args.push(current);
	return args;
}
function parseBindArgs(args) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--cwd") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.cwd !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.cwd = value;
			index += 1;
			continue;
		}
		if (arg === "--model") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.model !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.model = value;
			index += 1;
			continue;
		}
		if (arg === "--provider" || arg === "--model-provider") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.provider !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.provider = value;
			index += 1;
			continue;
		}
		if (!arg.startsWith("-") && !parsed.threadId) {
			parsed.threadId = arg;
			continue;
		}
		parsed.help = true;
	}
	parsed.threadId = normalizeOptionalString(parsed.threadId);
	parsed.cwd = normalizeOptionalString(parsed.cwd);
	parsed.model = normalizeOptionalString(parsed.model);
	parsed.provider = normalizeOptionalString(parsed.provider);
	return parsed;
}
function parseCodexCliSessionsArgs(args) {
	const parsed = { filter: "" };
	const filter = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--host" || arg === "--node") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.host !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.host = value;
			index += 1;
			continue;
		}
		if (arg === "--limit") {
			const value = readRequiredOptionValue(args, index);
			const parsedLimit = value ? Number.parseInt(value, 10) : NaN;
			if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
				parsed.help = true;
				continue;
			}
			parsed.limit = parsedLimit;
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) {
			parsed.help = true;
			continue;
		}
		filter.push(arg);
	}
	parsed.host = normalizeOptionalString(parsed.host);
	parsed.filter = filter.join(" ").trim();
	return parsed;
}
function parseResumeArgs(args) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--host" || arg === "--node") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.host !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.host = value;
			index += 1;
			continue;
		}
		if (arg === "--bind") {
			if (readRequiredOptionValue(args, index) !== "here" || parsed.bindHere !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.bindHere = true;
			index += 1;
			continue;
		}
		if (!arg.startsWith("-") && !parsed.threadId) {
			parsed.threadId = arg;
			continue;
		}
		parsed.help = true;
	}
	parsed.threadId = normalizeOptionalString(parsed.threadId);
	parsed.host = normalizeOptionalString(parsed.host);
	return parsed;
}
function parseComputerUseArgs(args) {
	const parsed = {
		action: "status",
		overrides: {},
		hasOverrides: false
	};
	let sawAction = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "status" || arg === "install") {
			if (sawAction) {
				parsed.help = true;
				continue;
			}
			sawAction = true;
			parsed.action = arg;
			continue;
		}
		if (arg === "--source" || arg === "--marketplace-source") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.overrides.marketplaceSource !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplaceSource = value;
			index += 1;
			continue;
		}
		if (arg === "--marketplace-path" || arg === "--path") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.overrides.marketplacePath !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplacePath = value;
			index += 1;
			continue;
		}
		if (arg === "--marketplace") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.overrides.marketplaceName !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplaceName = value;
			index += 1;
			continue;
		}
		if (arg === "--plugin") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.overrides.pluginName !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.pluginName = value;
			index += 1;
			continue;
		}
		if (arg === "--server" || arg === "--mcp-server") {
			const value = readRequiredOptionValue(args, index);
			if (!value || parsed.overrides.mcpServerName !== void 0) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.mcpServerName = value;
			index += 1;
			continue;
		}
		parsed.help = true;
	}
	parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
	parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
	return parsed;
}
function readRequiredOptionValue(args, index) {
	const value = args[index + 1];
	const normalized = value?.trim();
	if (!normalized || normalized.startsWith("-")) return;
	return value;
}
function normalizeComputerUseStringOverrides(overrides) {
	const normalized = {};
	const marketplaceSource = normalizeOptionalString(overrides.marketplaceSource);
	if (marketplaceSource) normalized.marketplaceSource = marketplaceSource;
	const marketplacePath = normalizeOptionalString(overrides.marketplacePath);
	if (marketplacePath) normalized.marketplacePath = marketplacePath;
	const marketplaceName = normalizeOptionalString(overrides.marketplaceName);
	if (marketplaceName) normalized.marketplaceName = marketplaceName;
	const pluginName = normalizeOptionalString(overrides.pluginName);
	if (pluginName) normalized.pluginName = pluginName;
	const mcpServerName = normalizeOptionalString(overrides.mcpServerName);
	if (mcpServerName) normalized.mcpServerName = mcpServerName;
	return normalized;
}
function normalizeOptionalString(value) {
	return value?.trim() || void 0;
}
//#endregion
export { handleCodexSubcommand };
