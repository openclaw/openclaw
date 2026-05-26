import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { a as asRecord } from "./record-coerce-CZkSQL9n.js";
import { n as sha256HexPrefix } from "./redact-identifier-B2TARbc1.js";
import { p as listExplicitConfiguredChannelIdsForConfig } from "./channel-plugin-ids-C3NqlKLT.js";
import { r as resolveReadOnlyChannelPluginsForConfig } from "./read-only--nr5YM31.js";
import { t as resolveMissingOfficialExternalChannelPluginRepairHint } from "./official-external-plugin-repair-hints-B-uYPwLQ.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-Pya1IDj5.js";
import { n as formatTimeAgo } from "./format-relative-ByQTDMWR.js";
import { t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-C13MnFmj.js";
import { i as formatChannelAllowFrom, n as resolveInspectedChannelAccount, r as buildChannelAccountSnapshot } from "./account-inspection-C0XEH9tt.js";
import { t as formatChannelStatusState } from "./status-state-BKT694wY.js";
import "./format-YpwU_lLG.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-CEZwpyhy.js";
import fs from "node:fs";
//#region src/commands/status-all/channels-token-summary.ts
function summarizeSources(sources) {
	const counts = /* @__PURE__ */ new Map();
	for (const s of sources) {
		const key = s?.trim() ? s.trim() : "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const parts = [...counts.entries()].toSorted((a, b) => b[1] - a[1]).map(([key, n]) => `${key}${n > 1 ? `×${n}` : ""}`);
	return {
		label: parts.length > 0 ? parts.join("+") : "unknown",
		parts
	};
}
function formatTokenHint(token, opts) {
	const t = token.trim();
	if (!t) return "empty";
	if (!opts.showSecrets) return `sha256:${sha256HexPrefix(t, 8)} · len ${t.length}`;
	const head = t.slice(0, 4);
	const tail = t.slice(-4);
	if (t.length <= 10) return `${t} · len ${t.length}`;
	return `${head}…${tail} · len ${t.length}`;
}
function summarizeTokenConfig(params) {
	const enabled = params.accounts.filter((a) => a.enabled);
	if (enabled.length === 0) return {
		state: null,
		detail: null
	};
	const accountRecs = enabled.map((a) => asRecord(a.account));
	const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
	const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
	const hasSigningSecretField = accountRecs.some((r) => "signingSecret" in r || "signingSecretSource" in r || "signingSecretStatus" in r);
	const hasTokenField = accountRecs.some((r) => "token" in r);
	if (!hasBotTokenField && !hasAppTokenField && !hasSigningSecretField && !hasTokenField) return {
		state: null,
		detail: null
	};
	const accountIsHttpMode = (rec) => typeof rec.mode === "string" && rec.mode.trim() === "http";
	const hasCredentialAvailable = (rec, valueKey, statusKey) => {
		const value = rec[valueKey];
		if (typeof value === "string" && value.trim()) return true;
		return rec[statusKey] === "available";
	};
	if (hasBotTokenField && hasSigningSecretField && enabled.every((a) => accountIsHttpMode(asRecord(a.account)))) {
		const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
		const ready = enabled.filter((a) => {
			const rec = asRecord(a.account);
			return hasCredentialAvailable(rec, "botToken", "botTokenStatus") && hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus");
		});
		const partial = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const hasBot = hasCredentialAvailable(rec, "botToken", "botTokenStatus");
			const hasSigning = hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus");
			return hasBot && !hasSigning || !hasBot && hasSigning;
		});
		if (unavailable.length > 0) return {
			state: "warn",
			detail: `configured http credentials unavailable in this command path · accounts ${unavailable.length}`
		};
		if (partial.length > 0) return {
			state: "warn",
			detail: `partial credentials (need bot+signing) · accounts ${partial.length}`
		};
		if (ready.length === 0) return {
			state: "setup",
			detail: "no credentials (need bot+signing)"
		};
		const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
		const signingSources = summarizeSources(ready.map((a) => a.snapshot.signingSecretSource ?? "none"));
		const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
		const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
		const signingSecret = typeof sample.signingSecret === "string" ? sample.signingSecret : "";
		const botHint = botToken.trim() ? formatTokenHint(botToken, { showSecrets: params.showSecrets }) : "";
		const signingHint = signingSecret.trim() ? formatTokenHint(signingSecret, { showSecrets: params.showSecrets }) : "";
		const hint = botHint || signingHint ? ` (bot ${botHint || "?"}, signing ${signingHint || "?"})` : "";
		return {
			state: "ok",
			detail: `credentials ok (bot ${botSources.label}, signing ${signingSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`
		};
	}
	if (hasBotTokenField && hasAppTokenField) {
		const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
		const ready = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const bot = normalizeOptionalString(rec.botToken) ?? "";
			const app = normalizeOptionalString(rec.appToken) ?? "";
			return Boolean(bot) && Boolean(app);
		});
		const partial = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const bot = normalizeOptionalString(rec.botToken) ?? "";
			const app = normalizeOptionalString(rec.appToken) ?? "";
			const hasBot = Boolean(bot);
			const hasApp = Boolean(app);
			return hasBot && !hasApp || !hasBot && hasApp;
		});
		if (partial.length > 0) return {
			state: "warn",
			detail: `partial tokens (need bot+app) · accounts ${partial.length}`
		};
		if (unavailable.length > 0) return {
			state: "warn",
			detail: `configured tokens unavailable in this command path · accounts ${unavailable.length}`
		};
		if (ready.length === 0) return {
			state: "setup",
			detail: "no tokens (need bot+app)"
		};
		const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
		const appSources = summarizeSources(ready.map((a) => a.snapshot.appTokenSource ?? "none"));
		const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
		const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
		const appToken = typeof sample.appToken === "string" ? sample.appToken : "";
		const botHint = botToken.trim() ? formatTokenHint(botToken, { showSecrets: params.showSecrets }) : "";
		const appHint = appToken.trim() ? formatTokenHint(appToken, { showSecrets: params.showSecrets }) : "";
		const hint = botHint || appHint ? ` (bot ${botHint || "?"}, app ${appHint || "?"})` : "";
		return {
			state: "ok",
			detail: `tokens ok (bot ${botSources.label}, app ${appSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`
		};
	}
	if (hasBotTokenField) {
		const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
		const ready = enabled.filter((a) => {
			const bot = normalizeOptionalString(asRecord(a.account).botToken) ?? "";
			return Boolean(bot);
		});
		if (unavailable.length > 0) return {
			state: "warn",
			detail: `configured bot token unavailable in this command path · accounts ${unavailable.length}`
		};
		if (ready.length === 0) return {
			state: "setup",
			detail: "no bot token"
		};
		const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
		const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
		const botHint = botToken.trim() ? formatTokenHint(botToken, { showSecrets: params.showSecrets }) : "";
		return {
			state: "ok",
			detail: `bot token config${botHint ? ` (${botHint})` : ""} · accounts ${ready.length}/${enabled.length || 1}`
		};
	}
	const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
	const ready = enabled.filter((a) => {
		const rec = asRecord(a.account);
		return Boolean(normalizeOptionalString(rec.token));
	});
	if (unavailable.length > 0) return {
		state: "warn",
		detail: `configured token unavailable in this command path · accounts ${unavailable.length}`
	};
	if (ready.length === 0) return {
		state: "setup",
		detail: "no token"
	};
	const sources = summarizeSources(ready.map((a) => a.snapshot.tokenSource));
	const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
	const token = typeof sample.token === "string" ? sample.token : "";
	const hint = token.trim() ? ` (${formatTokenHint(token, { showSecrets: params.showSecrets })})` : "";
	return {
		state: "ok",
		detail: `token ${sources.label}${hint} · accounts ${ready.length}/${enabled.length || 1}`
	};
}
//#endregion
//#region src/commands/status-all/channels.ts
function getLiveChannelAccounts(params) {
	const raw = asRecord(asRecord(params.liveChannelStatus).channelAccounts)[params.channelId];
	return Array.isArray(raw) ? raw.map(asRecord) : [];
}
function getLiveAccountId(account) {
	return normalizeOptionalString(account.accountId) ?? normalizeOptionalString(account.id) ?? normalizeOptionalString(account.name) ?? "default";
}
function findLiveChannelAccount(params) {
	return params.liveAccounts.find((account) => getLiveAccountId(account) === params.accountId) ?? (params.accountId === "default" && params.liveAccounts.length === 1 ? params.liveAccounts[0] ?? null : null);
}
function hasLiveCredentialAvailable(params) {
	const account = findLiveChannelAccount(params);
	if (!account) return false;
	if (hasConfiguredUnavailableCredentialStatus(account)) return false;
	return account.running === true || account.connected === true;
}
function markConfiguredUnavailableCredentialStatusesAvailable(account) {
	const record = { ...asRecord(account) };
	for (const key of [
		"tokenStatus",
		"botTokenStatus",
		"appTokenStatus",
		"signingSecretStatus"
	]) if (record[key] === "configured_unavailable") record[key] = "available";
	return record;
}
function existsSyncMaybe(p) {
	const path = normalizeOptionalString(p) ?? "";
	if (!path) return null;
	try {
		return fs.existsSync(path);
	} catch {
		return null;
	}
}
async function resolveChannelAccountRow(params) {
	const { plugin, cfg, sourceConfig, accountId } = params;
	const { account, enabled, configured } = await resolveInspectedChannelAccount({
		plugin,
		cfg,
		sourceConfig,
		accountId
	});
	return {
		accountId,
		account,
		enabled,
		configured,
		snapshot: buildChannelAccountSnapshot({
			plugin,
			cfg,
			accountId,
			account,
			enabled,
			configured
		})
	};
}
const formatAccountLabel = (params) => {
	const base = params.accountId || "default";
	if (params.name?.trim()) return `${base} (${params.name.trim()})`;
	return base;
};
const buildAccountNotes = (params) => {
	const { plugin, cfg, entry } = params;
	const notes = [];
	const snapshot = entry.snapshot;
	if (snapshot.enabled === false) notes.push("disabled");
	if (snapshot.dmPolicy) notes.push(`dm:${snapshot.dmPolicy}`);
	if (snapshot.tokenSource && snapshot.tokenSource !== "none") notes.push(`token:${snapshot.tokenSource}`);
	if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") notes.push(`bot:${snapshot.botTokenSource}`);
	if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") notes.push(`app:${snapshot.appTokenSource}`);
	if (snapshot.signingSecretSource && snapshot.signingSecretSource !== "none") notes.push(`signing:${snapshot.signingSecretSource}`);
	if (params.liveCredentialAvailable) notes.push("credential available in gateway runtime");
	else if (hasConfiguredUnavailableCredentialStatus(entry.account)) notes.push("secret unavailable in this command path");
	if (snapshot.baseUrl) notes.push(snapshot.baseUrl);
	if (snapshot.port != null) notes.push(`port:${snapshot.port}`);
	if (snapshot.cliPath) notes.push(`cli:${snapshot.cliPath}`);
	if (snapshot.dbPath) notes.push(`db:${snapshot.dbPath}`);
	const allowFrom = plugin.config.resolveAllowFrom?.({
		cfg,
		accountId: snapshot.accountId
	}) ?? snapshot.allowFrom;
	if (allowFrom?.length) {
		const formatted = formatChannelAllowFrom({
			plugin,
			cfg,
			accountId: snapshot.accountId,
			allowFrom
		}).slice(0, 3);
		if (formatted.length > 0) notes.push(`allow:${formatted.join(",")}`);
	}
	return notes;
};
function resolveLinkFields(summary) {
	const rec = asRecord(summary);
	const statusState = typeof rec.statusState === "string" ? rec.statusState : null;
	const linked = typeof rec.linked === "boolean" ? rec.linked : null;
	const authAgeMs = typeof rec.authAgeMs === "number" ? rec.authAgeMs : null;
	const self = asRecord(rec.self);
	return {
		statusState,
		linked,
		authAgeMs,
		selfE164: typeof self.e164 === "string" && self.e164.trim() ? self.e164.trim() : null
	};
}
function collectMissingPaths(accounts) {
	const missing = [];
	for (const entry of accounts) {
		const accountRec = asRecord(entry.account);
		const snapshotRec = asRecord(entry.snapshot);
		for (const key of [
			"tokenFile",
			"botTokenFile",
			"appTokenFile",
			"cliPath",
			"dbPath",
			"authDir"
		]) {
			const raw = accountRec[key] ?? snapshotRec[key];
			if (existsSyncMaybe(raw) === false) missing.push(String(raw));
		}
	}
	return missing;
}
async function buildChannelsTable(cfg, opts) {
	const showSecrets = opts?.showSecrets === true;
	const rows = [];
	const details = [];
	const sourceConfig = opts?.sourceConfig ?? cfg;
	const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(cfg, {
		activationSourceConfig: sourceConfig,
		includeSetupFallbackPlugins: opts?.includeSetupFallbackPlugins ?? true
	});
	for (const plugin of readOnlyPlugins.plugins) {
		const accountIds = plugin.config.listAccountIds(cfg);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds
		});
		const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
		const accounts = [];
		for (const accountId of resolvedAccountIds) accounts.push(await resolveChannelAccountRow({
			plugin,
			cfg,
			sourceConfig,
			accountId
		}));
		const liveAccounts = getLiveChannelAccounts({
			liveChannelStatus: opts?.liveChannelStatus,
			channelId: plugin.id
		});
		const anyEnabled = accounts.some((a) => a.enabled);
		const enabledAccounts = accounts.filter((a) => a.enabled);
		const configuredAccounts = enabledAccounts.filter((a) => a.configured);
		const unavailableConfiguredAccounts = enabledAccounts.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account) && !hasLiveCredentialAvailable({
			liveAccounts,
			accountId: a.accountId
		}));
		const accountsForTokenSummary = accounts.map((entry) => hasConfiguredUnavailableCredentialStatus(entry.account) && hasLiveCredentialAvailable({
			liveAccounts,
			accountId: entry.accountId
		}) ? {
			...entry,
			account: markConfiguredUnavailableCredentialStatusesAvailable(entry.account)
		} : entry);
		const defaultEntry = accounts.find((a) => a.accountId === defaultAccountId) ?? accounts[0];
		const link = resolveLinkFields(plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
			account: defaultEntry?.account ?? {},
			cfg,
			defaultAccountId,
			snapshot: defaultEntry?.snapshot ?? { accountId: defaultAccountId }
		}) : void 0);
		const missingPaths = collectMissingPaths(enabledAccounts);
		const tokenSummary = summarizeTokenConfig({
			accounts: accountsForTokenSummary,
			showSecrets
		});
		const issues = plugin.status?.collectStatusIssues ? plugin.status.collectStatusIssues(accounts.map((a) => a.snapshot)) : [];
		const label = plugin.meta.label ?? plugin.id;
		const state = (() => {
			if (!anyEnabled) return "off";
			if (missingPaths.length > 0) return "warn";
			if (issues.length > 0) return "warn";
			if (unavailableConfiguredAccounts.length > 0) return "warn";
			if (link.statusState === "unstable") return "warn";
			if (link.linked === false) return "setup";
			if (tokenSummary.state) return tokenSummary.state;
			if (link.linked === true) return "ok";
			if (configuredAccounts.length > 0) return "ok";
			return "setup";
		})();
		const detail = (() => {
			if (!anyEnabled) {
				if (!defaultEntry) return "disabled";
				return plugin.config.disabledReason?.(defaultEntry.account, cfg) ?? "disabled";
			}
			if (missingPaths.length > 0) return `missing file (${missingPaths[0]})`;
			if (issues.length > 0) return issues[0]?.message ?? "misconfigured";
			if (link.statusState) {
				if (link.statusState === "linked") {
					const extra = [];
					if (link.selfE164) extra.push(link.selfE164);
					if (link.authAgeMs != null && link.authAgeMs >= 0) extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
					if (accounts.length > 1 || plugin.meta.forceAccountBinding) extra.push(`accounts ${accounts.length || 1}`);
					return extra.length > 0 ? `${formatChannelStatusState(link.statusState)} · ${extra.join(" · ")}` : formatChannelStatusState(link.statusState);
				}
				return formatChannelStatusState(link.statusState);
			}
			if (link.linked !== null) {
				const base = link.linked ? "linked" : "not linked";
				const extra = [];
				if (link.linked && link.selfE164) extra.push(link.selfE164);
				if (link.linked && link.authAgeMs != null && link.authAgeMs >= 0) extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
				if (accounts.length > 1 || plugin.meta.forceAccountBinding) extra.push(`accounts ${accounts.length || 1}`);
				return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
			}
			if (unavailableConfiguredAccounts.length > 0) {
				if (tokenSummary.detail?.includes("unavailable")) return tokenSummary.detail;
				return `configured credentials unavailable in this command path · accounts ${unavailableConfiguredAccounts.length}`;
			}
			if (tokenSummary.detail) return tokenSummary.detail;
			if (configuredAccounts.length > 0) {
				const head = "configured";
				if (accounts.length <= 1 && !plugin.meta.forceAccountBinding) return head;
				return `${head} · accounts ${configuredAccounts.length}/${enabledAccounts.length || 1}`;
			}
			return (defaultEntry && plugin.config.unconfiguredReason ? plugin.config.unconfiguredReason(defaultEntry.account, cfg) : null) ?? "not configured";
		})();
		rows.push({
			id: plugin.id,
			label,
			enabled: anyEnabled,
			state,
			detail
		});
		if (configuredAccounts.length > 0) details.push({
			title: `${label} accounts`,
			columns: [
				"Account",
				"Status",
				"Notes"
			],
			rows: configuredAccounts.map((entry) => {
				const liveCredentialAvailable = hasLiveCredentialAvailable({
					liveAccounts,
					accountId: entry.accountId
				});
				const notes = buildAccountNotes({
					plugin,
					cfg,
					entry,
					liveCredentialAvailable
				});
				return {
					Account: formatAccountLabel({
						accountId: entry.accountId,
						name: entry.snapshot.name
					}),
					Status: entry.enabled && (!hasConfiguredUnavailableCredentialStatus(entry.account) || liveCredentialAvailable) ? "OK" : "WARN",
					Notes: notes.join(" · ")
				};
			})
		});
	}
	const visibleChannelIds = new Set(rows.map((row) => row.id));
	const missingCandidateChannelIds = [...new Set([
		...readOnlyPlugins.missingConfiguredChannelIds,
		...listExplicitConfiguredChannelIdsForConfig(sourceConfig),
		...listExplicitConfiguredChannelIdsForConfig(cfg)
	])].toSorted((left, right) => left.localeCompare(right));
	for (const channelId of missingCandidateChannelIds) {
		if (visibleChannelIds.has(channelId)) continue;
		const hint = resolveMissingOfficialExternalChannelPluginRepairHint({
			config: cfg,
			activationSourceConfig: sourceConfig,
			channelId
		});
		if (!hint || hint.channelId !== channelId) continue;
		rows.push({
			id: channelId,
			label: hint.label,
			enabled: true,
			state: "warn",
			detail: `plugin not installed - run ${hint.installCommand} or ${hint.doctorFixCommand}`
		});
		visibleChannelIds.add(channelId);
	}
	return {
		rows,
		details
	};
}
//#endregion
//#region src/commands/status.scan.runtime.ts
const statusScanRuntime = {
	collectChannelStatusIssues,
	buildChannelsTable
};
//#endregion
export { statusScanRuntime };
