import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BMw3fGLx.js";
import { n as classifyOAuthRefreshFailure, t as buildOAuthRefreshFailureLoginCommand } from "./oauth-refresh-failure-szcD_aib.js";
import "./auth-profiles-D6NMnufG.js";
import { i as formatAuthDoctorHint, n as resolveApiKeyForProfile } from "./oauth--yqMDDjF.js";
import { o as resolveProfileUnusableUntilForDisplay } from "./usage-DbhCKKrr.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { n as buildAuthHealthSummary, r as formatRemainingShort, t as DEFAULT_OAUTH_WARN_MS } from "./auth-health-Cr2XZkMa.js";
import { t as buildProviderAuthRecoveryHint } from "./provider-auth-guidance-_QKPMoA3.js";
//#region src/commands/doctor-auth.ts
const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_OAUTH_WARNING_TITLE = "Codex OAuth";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const LEGACY_CODEX_APIS = new Set(["openai-responses", "openai-completions"]);
function hasConfiguredCodexOAuthProfile(cfg) {
	return Object.values(cfg.auth?.profiles ?? {}).some((profile) => profile.provider === CODEX_PROVIDER_ID && profile.mode === "oauth");
}
function hasStoredCodexOAuthProfile() {
	const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	return Object.values(store.profiles).some((profile) => profile.provider === CODEX_PROVIDER_ID && profile.type === "oauth");
}
function normalizeCodexOverrideBaseUrl(baseUrl) {
	if (typeof baseUrl !== "string") return;
	return baseUrl.trim().replace(/\/+$/, "");
}
function isLegacyCodexTransportShape(value, inheritedBaseUrl) {
	if (!isRecord(value)) return false;
	const api = typeof value.api === "string" ? value.api : void 0;
	if (!api || !LEGACY_CODEX_APIS.has(api)) return false;
	const baseUrl = normalizeCodexOverrideBaseUrl(value.baseUrl ?? inheritedBaseUrl);
	return !baseUrl || baseUrl === OPENAI_BASE_URL;
}
function hasLegacyCodexTransportOverride(providerOverride) {
	if (!isRecord(providerOverride)) return false;
	if (isLegacyCodexTransportShape(providerOverride)) return true;
	const models = providerOverride.models;
	if (!Array.isArray(models)) return false;
	return models.some((model) => isLegacyCodexTransportShape(model, providerOverride.baseUrl));
}
function buildCodexProviderOverrideWarning(providerOverride) {
	const lines = [`- models.providers.${CODEX_PROVIDER_ID} contains a legacy transport override while Codex OAuth is configured.`, "- Older OpenAI transport settings can shadow the built-in Codex OAuth provider path."];
	if (isRecord(providerOverride)) {
		const record = providerOverride;
		if (typeof record.api === "string") lines.push(`- models.providers.${CODEX_PROVIDER_ID}.api=${record.api}`);
		if (typeof record.baseUrl === "string") lines.push(`- models.providers.${CODEX_PROVIDER_ID}.baseUrl=${record.baseUrl}`);
	}
	lines.push(`- Remove or rewrite the legacy transport override to restore the built-in Codex OAuth provider path after recent fixes.`);
	lines.push("- Custom proxies and header-only overrides can stay; this warning only targets old OpenAI transport settings.");
	return lines.join("\n");
}
function noteLegacyCodexProviderOverride(cfg) {
	const providerOverride = cfg.models?.providers?.[CODEX_PROVIDER_ID];
	if (!providerOverride) return;
	if (!hasLegacyCodexTransportOverride(providerOverride)) return;
	if (!hasConfiguredCodexOAuthProfile(cfg) && !hasStoredCodexOAuthProfile()) return;
	note(buildCodexProviderOverrideWarning(providerOverride), CODEX_OAUTH_WARNING_TITLE);
}
function resolveUnusableProfileHint(params) {
	if (params.kind === "disabled") {
		if (params.reason === "billing") return "Top up credits (provider billing) or switch provider.";
		if (params.reason === "auth_permanent" || params.reason === "auth") return "Refresh or replace credentials, then retry.";
	}
	return "Wait for cooldown or switch provider.";
}
function formatOAuthRefreshFailureReason(reason) {
	switch (reason) {
		case "refresh_token_reused": return "refresh_token_reused";
		case "invalid_grant": return "invalid_grant";
		case "sign_in_again": return "sign in again";
		case "invalid_refresh_token": return "invalid refresh token";
		case "revoked": return "revoked";
		default: return "refresh failed";
	}
}
function formatOAuthRefreshFailureDoctorLine(params) {
	const classified = classifyOAuthRefreshFailure(params.message);
	if (!classified) return null;
	const command = buildOAuthRefreshFailureLoginCommand(classified.provider ?? params.provider);
	if (classified.reason) return `- ${params.profileId}: re-auth required [${formatOAuthRefreshFailureReason(classified.reason)}] — Run \`${command}\`.`;
	return `- ${params.profileId}: OAuth refresh failed — Try again; if this persists, run \`${command}\`.`;
}
async function resolveAuthIssueHint(issue, cfg, store) {
	if (issue.reasonCode === "invalid_expires") return "Invalid token expires metadata. Set a future Unix ms timestamp or remove expires.";
	const providerHint = await formatAuthDoctorHint({
		cfg,
		store,
		provider: issue.provider,
		profileId: issue.profileId
	});
	if (providerHint.trim()) return providerHint;
	return buildProviderAuthRecoveryHint({ provider: issue.provider }).replace(/^Run /, "Re-auth via ");
}
async function formatAuthIssueLine(issue, cfg, store) {
	const remaining = issue.remainingMs !== void 0 ? ` (${formatRemainingShort(issue.remainingMs)})` : "";
	const hint = await resolveAuthIssueHint(issue, cfg, store);
	const reason = issue.reasonCode ? ` [${issue.reasonCode}]` : "";
	return `- ${issue.profileId}: ${issue.status}${reason}${remaining}${hint ? ` — ${hint}` : ""}`;
}
async function noteAuthProfileHealth(params) {
	if (Object.keys(params.cfg.auth?.profiles ?? {}).length === 0 && !hasAnyAuthProfileStoreSource()) return;
	const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: params.allowKeychainPrompt });
	const unusable = (() => {
		const now = Date.now();
		const out = [];
		for (const profileId of Object.keys(store.usageStats ?? {})) {
			const until = resolveProfileUnusableUntilForDisplay(store, profileId);
			if (!until || now >= until) continue;
			const stats = store.usageStats?.[profileId];
			const remaining = formatRemainingShort(until - now);
			const disabledActive = typeof stats?.disabledUntil === "number" && now < stats.disabledUntil;
			const kind = disabledActive ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}` : "cooldown";
			const hint = resolveUnusableProfileHint({
				kind: disabledActive ? "disabled" : "cooldown",
				reason: stats?.disabledReason
			});
			out.push(`- ${profileId}: ${kind} (${remaining})${hint ? ` — ${hint}` : ""}`);
		}
		return out;
	})();
	if (unusable.length > 0) note(unusable.join("\n"), "Auth profile cooldowns");
	let summary = buildAuthHealthSummary({
		store,
		cfg: params.cfg,
		warnAfterMs: DEFAULT_OAUTH_WARN_MS
	});
	const findIssues = () => summary.profiles.filter((profile) => (profile.type === "oauth" || profile.type === "token") && (profile.status === "expired" || profile.status === "expiring" || profile.status === "missing"));
	let issues = findIssues();
	if (issues.length === 0) return;
	if (await params.prompter.confirmAutoFix({
		message: "Refresh expiring OAuth tokens now? (static tokens need re-auth)",
		initialValue: true
	})) {
		const refreshTargets = issues.filter((issue) => issue.type === "oauth" && [
			"expired",
			"expiring",
			"missing"
		].includes(issue.status));
		const errors = [];
		for (const profile of refreshTargets) try {
			await resolveApiKeyForProfile({
				cfg: params.cfg,
				store,
				profileId: profile.profileId
			});
		} catch (err) {
			const message = formatErrorMessage(err);
			errors.push(formatOAuthRefreshFailureDoctorLine({
				profileId: profile.profileId,
				provider: profile.provider,
				message
			}) ?? `- ${profile.profileId}: ${message}`);
		}
		if (errors.length > 0) note(errors.join("\n"), "OAuth refresh errors");
		summary = buildAuthHealthSummary({
			store: ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }),
			cfg: params.cfg,
			warnAfterMs: DEFAULT_OAUTH_WARN_MS
		});
		issues = findIssues();
	}
	if (issues.length > 0) note((await Promise.all(issues.map((issue) => formatAuthIssueLine({
		profileId: issue.profileId,
		provider: issue.provider,
		status: issue.status,
		reasonCode: issue.reasonCode,
		remainingMs: issue.remainingMs
	}, params.cfg, store)))).join("\n"), "Model auth");
}
//#endregion
export { noteAuthProfileHealth, noteLegacyCodexProviderOverride };
