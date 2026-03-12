import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dt as isRich, Ot as theme, _t as info, qt as resolveGatewayPort } from "./entry.js";
import { $r as DEFAULT_PROVIDER, Gn as resolveConfiguredModelRef, N as readConfigFileSnapshot, Qr as DEFAULT_MODEL, Zr as DEFAULT_CONTEXT_TOKENS, j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { w as parseAgentSessionKey } from "./session-key-qmb11-mH.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-C9tYgTzw.js";
import { n as runExec } from "./exec-BhaMholX.js";
import { r as VERSION } from "./env-vars-DPtuUD7z.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-8UINyTAE.js";
import { X as resolveFreshSessionTotalTokens, c as loadSessionStore, tt as resolveMainSessionKey } from "./sessions-B8Y6oyPb.js";
import { n as listChannelPlugins } from "./plugins-BOmV0yTv.js";
import { Dn as formatChannelAllowFrom, En as buildChannelAccountSnapshot, Mn as peekSystemEvents, Ot as readRestartSentinel, Tn as buildChannelSummary, bn as formatUsageReportLines, kt as summarizeRestartSentinel, yn as loadProviderUsageSummary } from "./subagent-registry-BrzwRDvR.js";
import { l as resolveStorePath } from "./paths-DWsXK0S0.js";
import { n as callGateway, t as buildGatewayConnectionDetails } from "./call-D6IYi30Z.js";
import { o as getTailnetHostname, s as readTailscaleStatusJson } from "./tailscale-Cz0j5H8x.js";
import { n as inspectPortUsage, o as formatPortDiagnostics } from "./ports-B9YOEPbT.js";
import { r as getMemorySearchManager } from "./memory-cli-B3-7mJVU.js";
import { n as formatTimeAgo } from "./format-relative-CLDwoKCS.js";
import { r as formatDurationPrecise } from "./format-duration-BynaIN4v.js";
import { d as resolveContextTokensForModel, l as resolveSessionModelRef, n as classifySessionKey, r as listAgentsForGateway } from "./session-utils-DJsCvZA5.js";
import { o as getRemoteSkillEligibility } from "./skill-commands-BY4Kgv-u.js";
import { a as sha256HexPrefix } from "./active-listener-BugSXCgA.js";
import { n as withProgress } from "./progress-bvyZjsUc.js";
import { C as normalizeControlUiBasePath, g as resolveControlUiLinks } from "./onboard-helpers-CijgoJ1t.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-BgzIw8DX.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-B7OIB1_v.js";
import { s as resolveGatewayLogPaths, t as resolveGatewayService } from "./service-BYZQINUW.js";
import { t as formatRuntimeStatusWithDetails } from "./runtime-status-BZ7T-2AF.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-BPWQAMsI.js";
import { t as renderTable } from "./table-D7QRfQ5S.js";
import { i as resolveGatewayProbeAuth$1, s as probeGateway, t as runSecurityAudit } from "./audit-DgkVNA-0.js";
import { o as resolveHeartbeatSummaryForAgent, t as formatHealthChannelLines } from "./health-CXtv23mt.js";
import { _ as resolveUpdateChannelDisplay, a as formatGitInstallLabel, h as normalizeUpdateChannel, n as checkUpdateStatus, t as resolveDefaultChannelAccountContext } from "./channel-account-context-CvN7490K.js";
import { t as resolveNodeService } from "./node-service-YkAoOUN_.js";
import { n as redactSecrets, t as formatGatewayAuthUsed } from "./format-C2yPnOJl.js";
import { i as resolveUpdateAvailability, n as formatUpdateOneLiner, r as getUpdateCheckResult, t as formatUpdateAvailableHint } from "./status.update-C-aMt2e3.js";
import { t as shortenText } from "./text-format-93pzeERb.js";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";

//#region src/commands/gateway-presence.ts
function pickGatewaySelfPresence(presence) {
	if (!Array.isArray(presence)) return null;
	const entries = presence;
	const self = entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? entries.find((e) => typeof e.text === "string" && String(e.text).startsWith("Gateway:")) ?? null;
	if (!self) return null;
	return {
		host: typeof self.host === "string" ? self.host : void 0,
		ip: typeof self.ip === "string" ? self.ip : void 0,
		version: typeof self.version === "string" ? self.version : void 0,
		platform: typeof self.platform === "string" ? self.platform : void 0
	};
}

//#endregion
//#region src/memory/status-format.ts
function resolveMemoryVectorState(vector) {
	if (!vector.enabled) return {
		tone: "muted",
		state: "disabled"
	};
	if (vector.available === true) return {
		tone: "ok",
		state: "ready"
	};
	if (vector.available === false) return {
		tone: "warn",
		state: "unavailable"
	};
	return {
		tone: "muted",
		state: "unknown"
	};
}
function resolveMemoryFtsState(fts) {
	if (!fts.enabled) return {
		tone: "muted",
		state: "disabled"
	};
	return fts.available ? {
		tone: "ok",
		state: "ready"
	} : {
		tone: "warn",
		state: "unavailable"
	};
}
function resolveMemoryCacheSummary(cache) {
	if (!cache.enabled) return {
		tone: "muted",
		text: "cache off"
	};
	return {
		tone: "ok",
		text: `cache on${typeof cache.entries === "number" ? ` (${cache.entries})` : ""}`
	};
}

//#endregion
//#region src/infra/os-summary.ts
function safeTrim(value) {
	return typeof value === "string" ? value.trim() : "";
}
function macosVersion() {
	return safeTrim(spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).stdout) || os.release();
}
function resolveOsSummary() {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	return {
		platform,
		arch,
		release,
		label: (() => {
			if (platform === "darwin") return `macos ${macosVersion()} (${arch})`;
			if (platform === "win32") return `windows ${release} (${arch})`;
			return `${platform} ${release} (${arch})`;
		})()
	};
}

//#endregion
//#region src/commands/status-all/agents.ts
async function fileExists$1(p) {
	try {
		await fs$1.access(p);
		return true;
	} catch {
		return false;
	}
}
async function getAgentLocalStatuses$1(cfg) {
	const agentList = listAgentsForGateway(cfg);
	const now = Date.now();
	const agents = await Promise.all(agentList.agents.map(async (agent) => {
		const workspaceDir = (() => {
			try {
				return resolveAgentWorkspaceDir(cfg, agent.id);
			} catch {
				return null;
			}
		})();
		const bootstrapPending = workspaceDir != null ? await fileExists$1(path.join(workspaceDir, "BOOTSTRAP.md")) : null;
		const sessionsPath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
		const store = (() => {
			try {
				return loadSessionStore(sessionsPath);
			} catch {
				return {};
			}
		})();
		const updatedAt = Object.values(store).reduce((max, entry) => Math.max(max, entry?.updatedAt ?? 0), 0);
		const lastUpdatedAt = updatedAt > 0 ? updatedAt : null;
		const lastActiveAgeMs = lastUpdatedAt ? now - lastUpdatedAt : null;
		const sessionsCount = Object.keys(store).filter((k) => k !== "global" && k !== "unknown").length;
		return {
			id: agent.id,
			name: agent.name,
			workspaceDir,
			bootstrapPending,
			sessionsPath,
			sessionsCount,
			lastUpdatedAt,
			lastActiveAgeMs
		};
	}));
	const totalSessions = agents.reduce((sum, a) => sum + a.sessionsCount, 0);
	const bootstrapPendingCount = agents.reduce((sum, a) => sum + (a.bootstrapPending ? 1 : 0), 0);
	return {
		defaultId: agentList.defaultId,
		agents,
		totalSessions,
		bootstrapPendingCount
	};
}

//#endregion
//#region src/commands/status-all/channels.ts
const asRecord = (value) => value && typeof value === "object" ? value : {};
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
function existsSyncMaybe(p) {
	const path = p?.trim() || "";
	if (!path) return null;
	try {
		return fs.existsSync(path);
	} catch {
		return null;
	}
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
const formatAccountLabel = (params) => {
	const base = params.accountId || "default";
	if (params.name?.trim()) return `${base} (${params.name.trim()})`;
	return base;
};
const resolveAccountEnabled = (plugin, account, cfg) => {
	if (plugin.config.isEnabled) return plugin.config.isEnabled(account, cfg);
	return asRecord(account).enabled !== false;
};
const resolveAccountConfigured = async (plugin, account, cfg) => {
	if (plugin.config.isConfigured) return await plugin.config.isConfigured(account, cfg);
	return asRecord(account).configured !== false;
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
	const linked = typeof rec.linked === "boolean" ? rec.linked : null;
	const authAgeMs = typeof rec.authAgeMs === "number" ? rec.authAgeMs : null;
	const self = asRecord(rec.self);
	return {
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
function summarizeTokenConfig(params) {
	const enabled = params.accounts.filter((a) => a.enabled);
	if (enabled.length === 0) return {
		state: null,
		detail: null
	};
	const accountRecs = enabled.map((a) => asRecord(a.account));
	const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
	const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
	const hasTokenField = accountRecs.some((r) => "token" in r);
	if (!hasBotTokenField && !hasAppTokenField && !hasTokenField) return {
		state: null,
		detail: null
	};
	if (hasBotTokenField && hasAppTokenField) {
		const ready = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const bot = typeof rec.botToken === "string" ? rec.botToken.trim() : "";
			const app = typeof rec.appToken === "string" ? rec.appToken.trim() : "";
			return Boolean(bot) && Boolean(app);
		});
		const partial = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const bot = typeof rec.botToken === "string" ? rec.botToken.trim() : "";
			const app = typeof rec.appToken === "string" ? rec.appToken.trim() : "";
			const hasBot = Boolean(bot);
			const hasApp = Boolean(app);
			return hasBot && !hasApp || !hasBot && hasApp;
		});
		if (partial.length > 0) return {
			state: "warn",
			detail: `partial tokens (need bot+app) · accounts ${partial.length}`
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
		const ready = enabled.filter((a) => {
			const rec = asRecord(a.account);
			const bot = typeof rec.botToken === "string" ? rec.botToken.trim() : "";
			return Boolean(bot);
		});
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
	const ready = enabled.filter((a) => {
		const rec = asRecord(a.account);
		return typeof rec.token === "string" ? Boolean(rec.token.trim()) : false;
	});
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
async function buildChannelsTable(cfg, opts) {
	const showSecrets = opts?.showSecrets === true;
	const rows = [];
	const details = [];
	for (const plugin of listChannelPlugins()) {
		const accountIds = plugin.config.listAccountIds(cfg);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds
		});
		const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
		const accounts = [];
		for (const accountId of resolvedAccountIds) {
			const account = plugin.config.resolveAccount(cfg, accountId);
			const enabled = resolveAccountEnabled(plugin, account, cfg);
			const configured = await resolveAccountConfigured(plugin, account, cfg);
			const snapshot = buildChannelAccountSnapshot({
				plugin,
				cfg,
				accountId,
				account,
				enabled,
				configured
			});
			accounts.push({
				accountId,
				account,
				enabled,
				configured,
				snapshot
			});
		}
		const anyEnabled = accounts.some((a) => a.enabled);
		const enabledAccounts = accounts.filter((a) => a.enabled);
		const configuredAccounts = enabledAccounts.filter((a) => a.configured);
		const defaultEntry = accounts.find((a) => a.accountId === defaultAccountId) ?? accounts[0];
		const link = resolveLinkFields(plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
			account: defaultEntry?.account ?? {},
			cfg,
			defaultAccountId,
			snapshot: defaultEntry?.snapshot ?? { accountId: defaultAccountId }
		}) : void 0);
		const missingPaths = collectMissingPaths(enabledAccounts);
		const tokenSummary = summarizeTokenConfig({
			plugin,
			cfg,
			accounts,
			showSecrets
		});
		const issues = plugin.status?.collectStatusIssues ? plugin.status.collectStatusIssues(accounts.map((a) => a.snapshot)) : [];
		const label = plugin.meta.label ?? plugin.id;
		const state = (() => {
			if (!anyEnabled) return "off";
			if (missingPaths.length > 0) return "warn";
			if (issues.length > 0) return "warn";
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
			if (link.linked !== null) {
				const base = link.linked ? "linked" : "not linked";
				const extra = [];
				if (link.linked && link.selfE164) extra.push(link.selfE164);
				if (link.linked && link.authAgeMs != null && link.authAgeMs >= 0) extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
				if (accounts.length > 1 || plugin.meta.forceAccountBinding) extra.push(`accounts ${accounts.length || 1}`);
				return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
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
				const notes = buildAccountNotes({
					plugin,
					cfg,
					entry
				});
				return {
					Account: formatAccountLabel({
						accountId: entry.accountId,
						name: entry.snapshot.name
					}),
					Status: entry.enabled ? "OK" : "WARN",
					Notes: notes.join(" · ")
				};
			})
		});
	}
	return {
		rows,
		details
	};
}

//#endregion
//#region src/commands/status-all/gateway.ts
async function readFileTailLines(filePath, maxLines) {
	const raw = await fs$1.readFile(filePath, "utf8").catch(() => "");
	if (!raw.trim()) return [];
	const lines = raw.replace(/\r/g, "").split("\n");
	return lines.slice(Math.max(0, lines.length - maxLines)).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}
function countMatches(haystack, needle) {
	if (!haystack || !needle) return 0;
	return haystack.split(needle).length - 1;
}
function shorten(message, maxLen) {
	const cleaned = message.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxLen) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}
function normalizeGwsLine(line) {
	return line.replace(/\s+runId=[^\s]+/g, "").replace(/\s+conn=[^\s]+/g, "").replace(/\s+id=[^\s]+/g, "").replace(/\s+error=Error:.*$/g, "").trim();
}
function consumeJsonBlock(lines, startIndex) {
	const startLine = lines[startIndex] ?? "";
	const braceAt = startLine.indexOf("{");
	if (braceAt < 0) return null;
	const parts = [startLine.slice(braceAt)];
	let depth = countMatches(parts[0] ?? "", "{") - countMatches(parts[0] ?? "", "}");
	let i = startIndex;
	while (depth > 0 && i + 1 < lines.length) {
		i += 1;
		const next = lines[i] ?? "";
		parts.push(next);
		depth += countMatches(next, "{") - countMatches(next, "}");
	}
	return {
		json: parts.join("\n"),
		endIndex: i
	};
}
function summarizeLogTail(rawLines, opts) {
	const maxLines = Math.max(6, opts?.maxLines ?? 26);
	const out = [];
	const groups = /* @__PURE__ */ new Map();
	const addGroup = (key, base) => {
		const existing = groups.get(key);
		if (existing) {
			existing.count += 1;
			return;
		}
		groups.set(key, {
			count: 1,
			index: out.length,
			base
		});
		out.push(base);
	};
	const addLine = (line) => {
		const trimmed = line.trimEnd();
		if (!trimmed) return;
		out.push(trimmed);
	};
	const lines = rawLines.map((line) => line.trimEnd()).filter(Boolean);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const trimmedStart = line.trimStart();
		if ((trimmedStart.startsWith("\"") || trimmedStart === "}" || trimmedStart === "{" || trimmedStart.startsWith("}") || trimmedStart.startsWith("{")) && !trimmedStart.startsWith("[") && !trimmedStart.startsWith("#")) continue;
		const tokenRefresh = line.match(/^\[([^\]]+)\]\s+Token refresh failed:\s*(\d+)\s*(\{)?\s*$/);
		if (tokenRefresh) {
			const tag = tokenRefresh[1] ?? "unknown";
			const status = tokenRefresh[2] ?? "unknown";
			const block = consumeJsonBlock(lines, i);
			if (block) {
				i = block.endIndex;
				const parsed = (() => {
					try {
						return JSON.parse(block.json);
					} catch {
						return null;
					}
				})();
				const code = parsed?.error?.code?.trim() || null;
				const msg = parsed?.error?.message?.trim() || null;
				const msgShort = msg ? msg.toLowerCase().includes("signing in again") ? "re-auth required" : shorten(msg, 52) : null;
				const base = `[${tag}] token refresh ${status}${code ? ` ${code}` : ""}${msgShort ? ` · ${msgShort}` : ""}`;
				addGroup(`token:${tag}:${status}:${code ?? ""}:${msgShort ?? ""}`, base);
				continue;
			}
		}
		const embedded = line.match(/^Embedded agent failed before reply:\s+OAuth token refresh failed for ([^:]+):/);
		if (embedded) {
			const provider = embedded[1]?.trim() || "unknown";
			addGroup(`embedded:${provider}`, `Embedded agent: OAuth token refresh failed (${provider})`);
			continue;
		}
		if (line.startsWith("[gws]") && line.includes("errorCode=UNAVAILABLE") && line.includes("OAuth token refresh failed")) {
			const normalized = normalizeGwsLine(line);
			addGroup(`gws:${normalized}`, normalized);
			continue;
		}
		addLine(line);
	}
	for (const g of groups.values()) {
		if (g.count <= 1) continue;
		out[g.index] = `${g.base} ×${g.count}`;
	}
	const deduped = [];
	for (const line of out) {
		if (deduped[deduped.length - 1] === line) continue;
		deduped.push(line);
	}
	if (deduped.length <= maxLines) return deduped;
	const head = Math.min(6, Math.floor(maxLines / 3));
	const tail = Math.max(1, maxLines - head - 1);
	return [
		...deduped.slice(0, head),
		`… ${deduped.length - head - tail} lines omitted …`,
		...deduped.slice(-tail)
	];
}

//#endregion
//#region src/commands/status-all/diagnosis.ts
async function appendStatusAllDiagnosis(params) {
	const { lines, muted, ok, warn, fail } = params;
	const emitCheck = (label, status) => {
		const icon = status === "ok" ? ok("✓") : status === "warn" ? warn("!") : fail("✗");
		const colored = status === "ok" ? ok(label) : status === "warn" ? warn(label) : fail(label);
		lines.push(`${icon} ${colored}`);
	};
	lines.push("");
	lines.push(muted("Gateway connection details:"));
	for (const line of redactSecrets(params.connectionDetailsForReport).split("\n").map((l) => l.trimEnd())) lines.push(`  ${muted(line)}`);
	lines.push("");
	if (params.snap) {
		const status = !params.snap.exists ? "fail" : params.snap.valid ? "ok" : "warn";
		emitCheck(`Config: ${params.snap.path ?? "(unknown)"}`, status);
		const issues = [...params.snap.legacyIssues ?? [], ...params.snap.issues ?? []];
		const uniqueIssues = issues.filter((issue, index) => issues.findIndex((x) => x.path === issue.path && x.message === issue.message) === index);
		for (const issue of uniqueIssues.slice(0, 12)) lines.push(`  - ${issue.path}: ${issue.message}`);
		if (uniqueIssues.length > 12) lines.push(`  ${muted(`… +${uniqueIssues.length - 12} more`)}`);
	} else emitCheck("Config: read failed", "warn");
	if (params.remoteUrlMissing) {
		lines.push("");
		emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
		lines.push(`  ${muted("Fix: set gateway.remote.url, or set gateway.mode=local.")}`);
	}
	if (params.sentinel?.payload) {
		emitCheck("Restart sentinel present", "warn");
		lines.push(`  ${muted(`${summarizeRestartSentinel(params.sentinel.payload)} · ${formatTimeAgo(Date.now() - params.sentinel.payload.ts)}`)}`);
	} else emitCheck("Restart sentinel: none", "ok");
	const lastErrClean = params.lastErr?.trim() ?? "";
	const isTrivialLastErr = lastErrClean.length < 8 || lastErrClean === "}" || lastErrClean === "{";
	if (lastErrClean && !isTrivialLastErr) {
		lines.push("");
		lines.push(muted("Gateway last log line:"));
		lines.push(`  ${muted(redactSecrets(lastErrClean))}`);
	}
	if (params.portUsage) {
		const portOk = params.portUsage.listeners.length === 0;
		emitCheck(`Port ${params.port}`, portOk ? "ok" : "warn");
		if (!portOk) for (const line of formatPortDiagnostics(params.portUsage)) lines.push(`  ${muted(line)}`);
	}
	{
		const backend = params.tailscale.backendState ?? "unknown";
		const okBackend = backend === "Running";
		const hasDns = Boolean(params.tailscale.dnsName);
		emitCheck(params.tailscaleMode === "off" ? `Tailscale: off · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}` : `Tailscale: ${params.tailscaleMode} · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}`, okBackend && (params.tailscaleMode === "off" || hasDns) ? "ok" : "warn");
		if (params.tailscale.error) lines.push(`  ${muted(`error: ${params.tailscale.error}`)}`);
		if (params.tailscale.ips.length > 0) lines.push(`  ${muted(`ips: ${params.tailscale.ips.slice(0, 3).join(", ")}${params.tailscale.ips.length > 3 ? "…" : ""}`)}`);
		if (params.tailscaleHttpsUrl) lines.push(`  ${muted(`https: ${params.tailscaleHttpsUrl}`)}`);
	}
	if (params.skillStatus) {
		const eligible = params.skillStatus.skills.filter((s) => s.eligible).length;
		const missing = params.skillStatus.skills.filter((s) => s.eligible && Object.values(s.missing).some((arr) => arr.length)).length;
		emitCheck(`Skills: ${eligible} eligible · ${missing} missing · ${params.skillStatus.workspaceDir}`, missing === 0 ? "ok" : "warn");
	}
	params.progress.setLabel("Reading logs…");
	const logPaths = (() => {
		try {
			return resolveGatewayLogPaths(process.env);
		} catch {
			return null;
		}
	})();
	if (logPaths) {
		params.progress.setLabel("Reading logs…");
		const [stderrTail, stdoutTail] = await Promise.all([readFileTailLines(logPaths.stderrPath, 40).catch(() => []), readFileTailLines(logPaths.stdoutPath, 40).catch(() => [])]);
		if (stderrTail.length > 0 || stdoutTail.length > 0) {
			lines.push("");
			lines.push(muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`));
			lines.push(`  ${muted(`# stderr: ${logPaths.stderrPath}`)}`);
			for (const line of summarizeLogTail(stderrTail, { maxLines: 22 }).map(redactSecrets)) lines.push(`  ${muted(line)}`);
			lines.push(`  ${muted(`# stdout: ${logPaths.stdoutPath}`)}`);
			for (const line of summarizeLogTail(stdoutTail, { maxLines: 22 }).map(redactSecrets)) lines.push(`  ${muted(line)}`);
		}
	}
	params.progress.tick();
	if (params.channelsStatus) {
		emitCheck(`Channel issues (${params.channelIssues.length || "none"})`, params.channelIssues.length === 0 ? "ok" : "warn");
		for (const issue of params.channelIssues.slice(0, 12)) {
			const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
			lines.push(`  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`);
		}
		if (params.channelIssues.length > 12) lines.push(`  ${muted(`… +${params.channelIssues.length - 12} more`)}`);
	} else emitCheck(`Channel issues skipped (gateway ${params.gatewayReachable ? "query failed" : "unreachable"})`, "warn");
	const healthErr = (() => {
		if (!params.health || typeof params.health !== "object") return "";
		const record = params.health;
		if (!("error" in record)) return "";
		const value = record.error;
		if (!value) return "";
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return "[unserializable error]";
		}
	})();
	if (healthErr) {
		lines.push("");
		lines.push(muted("Gateway health:"));
		lines.push(`  ${muted(redactSecrets(healthErr))}`);
	}
	lines.push("");
	lines.push(muted("Pasteable debug report. Auth tokens redacted."));
	lines.push("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
	lines.push("");
}

//#endregion
//#region src/commands/status-all/report-lines.ts
async function buildStatusAllReportLines(params) {
	const rich = isRich();
	const heading = (text) => rich ? theme.heading(text) : text;
	const ok = (text) => rich ? theme.success(text) : text;
	const warn = (text) => rich ? theme.warn(text) : text;
	const fail = (text) => rich ? theme.error(text) : text;
	const muted = (text) => rich ? theme.muted(text) : text;
	const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
	const overview = renderTable({
		width: tableWidth,
		columns: [{
			key: "Item",
			header: "Item",
			minWidth: 10
		}, {
			key: "Value",
			header: "Value",
			flex: true,
			minWidth: 24
		}],
		rows: params.overviewRows
	});
	const channelRows = params.channels.rows.map((row) => ({
		channelId: row.id,
		Channel: row.label,
		Enabled: row.enabled ? ok("ON") : muted("OFF"),
		State: row.state === "ok" ? ok("OK") : row.state === "warn" ? warn("WARN") : row.state === "off" ? muted("OFF") : theme.accentDim("SETUP"),
		Detail: row.detail
	}));
	const channelIssuesByChannel = (() => {
		const map = /* @__PURE__ */ new Map();
		for (const issue of params.channelIssues) {
			const key = issue.channel;
			const list = map.get(key);
			if (list) list.push(issue);
			else map.set(key, [issue]);
		}
		return map;
	})();
	const channelsTable = renderTable({
		width: tableWidth,
		columns: [
			{
				key: "Channel",
				header: "Channel",
				minWidth: 10
			},
			{
				key: "Enabled",
				header: "Enabled",
				minWidth: 7
			},
			{
				key: "State",
				header: "State",
				minWidth: 8
			},
			{
				key: "Detail",
				header: "Detail",
				flex: true,
				minWidth: 28
			}
		],
		rows: channelRows.map((row) => {
			const issues = channelIssuesByChannel.get(row.channelId) ?? [];
			if (issues.length === 0) return row;
			const issue = issues[0];
			const suffix = ` · ${warn(`gateway: ${String(issue.message).slice(0, 90)}`)}`;
			return {
				...row,
				State: warn("WARN"),
				Detail: `${row.Detail}${suffix}`
			};
		})
	});
	const agentsTable = renderTable({
		width: tableWidth,
		columns: [
			{
				key: "Agent",
				header: "Agent",
				minWidth: 12
			},
			{
				key: "BootstrapFile",
				header: "Bootstrap file",
				minWidth: 14
			},
			{
				key: "Sessions",
				header: "Sessions",
				align: "right",
				minWidth: 8
			},
			{
				key: "Active",
				header: "Active",
				minWidth: 10
			},
			{
				key: "Store",
				header: "Store",
				flex: true,
				minWidth: 34
			}
		],
		rows: params.agentStatus.agents.map((a) => ({
			Agent: a.name?.trim() ? `${a.id} (${a.name.trim()})` : a.id,
			BootstrapFile: a.bootstrapPending === true ? warn("PRESENT") : a.bootstrapPending === false ? ok("ABSENT") : "unknown",
			Sessions: String(a.sessionsCount),
			Active: a.lastActiveAgeMs != null ? formatTimeAgo(a.lastActiveAgeMs) : "unknown",
			Store: a.sessionsPath
		}))
	});
	const lines = [];
	lines.push(heading("OpenClaw status --all"));
	lines.push("");
	lines.push(heading("Overview"));
	lines.push(overview.trimEnd());
	lines.push("");
	lines.push(heading("Channels"));
	lines.push(channelsTable.trimEnd());
	for (const detail of params.channels.details) {
		lines.push("");
		lines.push(heading(detail.title));
		lines.push(renderTable({
			width: tableWidth,
			columns: detail.columns.map((c) => ({
				key: c,
				header: c,
				flex: c === "Notes",
				minWidth: c === "Notes" ? 28 : 10
			})),
			rows: detail.rows.map((r) => ({
				...r,
				...r.Status === "OK" ? { Status: ok("OK") } : r.Status === "WARN" ? { Status: warn("WARN") } : {}
			}))
		}).trimEnd());
	}
	lines.push("");
	lines.push(heading("Agents"));
	lines.push(agentsTable.trimEnd());
	lines.push("");
	lines.push(heading("Diagnosis (read-only)"));
	await appendStatusAllDiagnosis({
		lines,
		progress: params.progress,
		muted,
		ok,
		warn,
		fail,
		connectionDetailsForReport: params.connectionDetailsForReport,
		...params.diagnosis
	});
	return lines;
}

//#endregion
//#region src/commands/status-all.ts
async function statusAllCommand(runtime, opts) {
	await withProgress({
		label: "Scanning status --all…",
		total: 11
	}, async (progress) => {
		progress.setLabel("Loading config…");
		const cfg = loadConfig();
		const osSummary = resolveOsSummary();
		const snap = await readConfigFileSnapshot().catch(() => null);
		progress.tick();
		progress.setLabel("Checking Tailscale…");
		const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
		const tailscale = await (async () => {
			try {
				const parsed = await readTailscaleStatusJson(runExec, { timeoutMs: 1200 });
				const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : null;
				const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self : null;
				const dnsNameRaw = self && typeof self.DNSName === "string" ? self.DNSName : null;
				return {
					ok: true,
					backendState,
					dnsName: dnsNameRaw ? dnsNameRaw.replace(/\.$/, "") : null,
					ips: self && Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [],
					error: null
				};
			} catch (err) {
				return {
					ok: false,
					backendState: null,
					dnsName: null,
					ips: [],
					error: String(err)
				};
			}
		})();
		const tailscaleHttpsUrl = tailscaleMode !== "off" && tailscale.dnsName ? `https://${tailscale.dnsName}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}` : null;
		progress.tick();
		progress.setLabel("Checking for updates…");
		const update = await checkUpdateStatus({
			root: await resolveOpenClawPackageRoot({
				moduleUrl: import.meta.url,
				argv1: process.argv[1],
				cwd: process.cwd()
			}),
			timeoutMs: 6500,
			fetchGit: true,
			includeRegistry: true
		});
		const channelLabel = resolveUpdateChannelDisplay({
			configChannel: normalizeUpdateChannel(cfg.update?.channel),
			installKind: update.installKind,
			gitTag: update.git?.tag ?? null,
			gitBranch: update.git?.branch ?? null
		}).label;
		const gitLabel = formatGitInstallLabel(update);
		progress.tick();
		progress.setLabel("Probing gateway…");
		const connection = buildGatewayConnectionDetails({ config: cfg });
		const isRemoteMode = cfg.gateway?.mode === "remote";
		const remoteUrlRaw = typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
		const remoteUrlMissing = isRemoteMode && !remoteUrlRaw;
		const gatewayMode = isRemoteMode ? "remote" : "local";
		const localFallbackAuth = resolveGatewayProbeAuth$1({
			cfg,
			mode: "local"
		});
		const remoteAuth = resolveGatewayProbeAuth$1({
			cfg,
			mode: "remote"
		});
		const probeAuth = isRemoteMode && !remoteUrlMissing ? remoteAuth : localFallbackAuth;
		const gatewayProbe = await probeGateway({
			url: connection.url,
			auth: probeAuth,
			timeoutMs: Math.min(5e3, opts?.timeoutMs ?? 1e4)
		}).catch(() => null);
		const gatewayReachable = gatewayProbe?.ok === true;
		const gatewaySelf = pickGatewaySelfPresence(gatewayProbe?.presence ?? null);
		progress.tick();
		progress.setLabel("Checking services…");
		const readServiceSummary = async (service) => {
			try {
				const [loaded, runtimeInfo, command] = await Promise.all([
					service.isLoaded({ env: process.env }).catch(() => false),
					service.readRuntime(process.env).catch(() => void 0),
					service.readCommand(process.env).catch(() => null)
				]);
				const installed = command != null;
				return {
					label: service.label,
					installed,
					loaded,
					loadedText: loaded ? service.loadedText : service.notLoadedText,
					runtime: runtimeInfo
				};
			} catch {
				return null;
			}
		};
		const daemon = await readServiceSummary(resolveGatewayService());
		const nodeService = await readServiceSummary(resolveNodeService());
		progress.tick();
		progress.setLabel("Scanning agents…");
		const agentStatus = await getAgentLocalStatuses$1(cfg);
		progress.tick();
		progress.setLabel("Summarizing channels…");
		const channels = await buildChannelsTable(cfg, { showSecrets: false });
		progress.tick();
		const connectionDetailsForReport = (() => {
			if (!remoteUrlMissing) return connection.message;
			const bindMode = cfg.gateway?.bind ?? "loopback";
			return [
				"Gateway mode: remote",
				"Gateway target: (missing gateway.remote.url)",
				`Config: ${snap?.path?.trim() ? snap.path.trim() : "(unknown config path)"}`,
				`Bind: ${bindMode}`,
				`Local fallback (used for probes): ${connection.url}`,
				"Fix: set gateway.remote.url, or set gateway.mode=local."
			].join("\n");
		})();
		const callOverrides = remoteUrlMissing ? {
			url: connection.url,
			token: localFallbackAuth.token,
			password: localFallbackAuth.password
		} : {};
		progress.setLabel("Querying gateway…");
		const health = gatewayReachable ? await callGateway({
			method: "health",
			timeoutMs: Math.min(8e3, opts?.timeoutMs ?? 1e4),
			...callOverrides
		}).catch((err) => ({ error: String(err) })) : { error: gatewayProbe?.error ?? "gateway unreachable" };
		const channelsStatus = gatewayReachable ? await callGateway({
			method: "channels.status",
			params: {
				probe: false,
				timeoutMs: opts?.timeoutMs ?? 1e4
			},
			timeoutMs: Math.min(8e3, opts?.timeoutMs ?? 1e4),
			...callOverrides
		}).catch(() => null) : null;
		const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
		progress.tick();
		progress.setLabel("Checking local state…");
		const sentinel = await readRestartSentinel().catch(() => null);
		const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
		const port = resolveGatewayPort(cfg);
		const portUsage = await inspectPortUsage(port).catch(() => null);
		progress.tick();
		const defaultWorkspace = agentStatus.agents.find((a) => a.id === agentStatus.defaultId)?.workspaceDir ?? agentStatus.agents[0]?.workspaceDir ?? null;
		const skillStatus = defaultWorkspace != null ? (() => {
			try {
				return buildWorkspaceSkillStatus(defaultWorkspace, {
					config: cfg,
					eligibility: { remote: getRemoteSkillEligibility() }
				});
			} catch {
				return null;
			}
		})() : null;
		const dashboard = cfg.gateway?.controlUi?.enabled ?? true ? resolveControlUiLinks({
			port,
			bind: cfg.gateway?.bind,
			customBindHost: cfg.gateway?.customBindHost,
			basePath: cfg.gateway?.controlUi?.basePath
		}).httpUrl : null;
		const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
		const gatewayTarget = remoteUrlMissing ? `fallback ${connection.url}` : connection.url;
		const gatewayStatus = gatewayReachable ? `reachable ${formatDurationPrecise(gatewayProbe?.connectLatencyMs ?? 0)}` : gatewayProbe?.error ? `unreachable (${gatewayProbe.error})` : "unreachable";
		const gatewayAuth = gatewayReachable ? ` · auth ${formatGatewayAuthUsed(probeAuth)}` : "";
		const gatewaySelfLine = gatewaySelf?.host || gatewaySelf?.ip || gatewaySelf?.version || gatewaySelf?.platform ? [
			gatewaySelf.host ? gatewaySelf.host : null,
			gatewaySelf.ip ? `(${gatewaySelf.ip})` : null,
			gatewaySelf.version ? `app ${gatewaySelf.version}` : null,
			gatewaySelf.platform ? gatewaySelf.platform : null
		].filter(Boolean).join(" ") : null;
		const aliveThresholdMs = 10 * 6e4;
		const aliveAgents = agentStatus.agents.filter((a) => a.lastActiveAgeMs != null && a.lastActiveAgeMs <= aliveThresholdMs).length;
		const lines = await buildStatusAllReportLines({
			progress,
			overviewRows: [
				{
					Item: "Version",
					Value: VERSION
				},
				{
					Item: "OS",
					Value: osSummary.label
				},
				{
					Item: "Node",
					Value: process.versions.node
				},
				{
					Item: "Config",
					Value: snap?.path?.trim() ? snap.path.trim() : "(unknown config path)"
				},
				dashboard ? {
					Item: "Dashboard",
					Value: dashboard
				} : {
					Item: "Dashboard",
					Value: "disabled"
				},
				{
					Item: "Tailscale",
					Value: tailscaleMode === "off" ? `off${tailscale.backendState ? ` · ${tailscale.backendState}` : ""}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}` : tailscale.dnsName && tailscaleHttpsUrl ? `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · ${tailscale.dnsName} · ${tailscaleHttpsUrl}` : `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · magicdns unknown`
				},
				{
					Item: "Channel",
					Value: channelLabel
				},
				...gitLabel ? [{
					Item: "Git",
					Value: gitLabel
				}] : [],
				{
					Item: "Update",
					Value: updateLine
				},
				{
					Item: "Gateway",
					Value: `${gatewayMode}${remoteUrlMissing ? " (remote.url missing)" : ""} · ${gatewayTarget} (${connection.urlSource}) · ${gatewayStatus}${gatewayAuth}`
				},
				{
					Item: "Security",
					Value: `Run: ${formatCliCommand("openclaw security audit --deep")}`
				},
				gatewaySelfLine ? {
					Item: "Gateway self",
					Value: gatewaySelfLine
				} : {
					Item: "Gateway self",
					Value: "unknown"
				},
				daemon ? {
					Item: "Gateway service",
					Value: !daemon.installed ? `${daemon.label} not installed` : `${daemon.label} ${daemon.installed ? "installed · " : ""}${daemon.loadedText}${daemon.runtime?.status ? ` · ${daemon.runtime.status}` : ""}${daemon.runtime?.pid ? ` (pid ${daemon.runtime.pid})` : ""}`
				} : {
					Item: "Gateway service",
					Value: "unknown"
				},
				nodeService ? {
					Item: "Node service",
					Value: !nodeService.installed ? `${nodeService.label} not installed` : `${nodeService.label} ${nodeService.installed ? "installed · " : ""}${nodeService.loadedText}${nodeService.runtime?.status ? ` · ${nodeService.runtime.status}` : ""}${nodeService.runtime?.pid ? ` (pid ${nodeService.runtime.pid})` : ""}`
				} : {
					Item: "Node service",
					Value: "unknown"
				},
				{
					Item: "Agents",
					Value: `${agentStatus.agents.length} total · ${agentStatus.bootstrapPendingCount} bootstrapping · ${aliveAgents} active · ${agentStatus.totalSessions} sessions`
				}
			],
			channels,
			channelIssues: channelIssues.map((issue) => ({
				channel: issue.channel,
				message: issue.message
			})),
			agentStatus,
			connectionDetailsForReport,
			diagnosis: {
				snap,
				remoteUrlMissing,
				sentinel,
				lastErr,
				port,
				portUsage,
				tailscaleMode,
				tailscale,
				tailscaleHttpsUrl,
				skillStatus,
				channelsStatus,
				channelIssues,
				gatewayReachable,
				health
			}
		});
		progress.setLabel("Rendering…");
		runtime.log(lines.join("\n"));
		progress.tick();
	});
}

//#endregion
//#region src/commands/status.format.ts
const formatKTokens = (value) => `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
const formatDuration = (ms) => {
	if (ms == null || !Number.isFinite(ms)) return "unknown";
	return formatDurationPrecise(ms, { decimals: 1 });
};
const formatTokensCompact = (sess) => {
	const used = sess.totalTokens;
	const ctx = sess.contextTokens;
	const cacheRead = sess.cacheRead;
	const cacheWrite = sess.cacheWrite;
	let result = "";
	if (used == null) result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
	else if (!ctx) result = `${formatKTokens(used)} used`;
	else {
		const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
		result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
	}
	if (typeof cacheRead === "number" && cacheRead > 0) {
		const total = typeof used === "number" ? used : cacheRead + (typeof cacheWrite === "number" ? cacheWrite : 0);
		const hitRate = Math.round(cacheRead / total * 100);
		result += ` · 🗄️ ${hitRate}% cached`;
	}
	return result;
};
const formatDaemonRuntimeShort = (runtime) => {
	if (!runtime) return null;
	const details = [];
	const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
	const noisyLaunchctlDetail = runtime.missingUnit === true && detail.toLowerCase().includes("could not find service");
	if (detail && !noisyLaunchctlDetail) details.push(detail);
	return formatRuntimeStatusWithDetails({
		status: runtime.status,
		pid: runtime.pid,
		state: runtime.state,
		details
	});
};

//#endregion
//#region src/commands/status.daemon.ts
async function buildDaemonStatusSummary(service, fallbackLabel) {
	try {
		const [loaded, runtime, command] = await Promise.all([
			service.isLoaded({ env: process.env }).catch(() => false),
			service.readRuntime(process.env).catch(() => void 0),
			service.readCommand(process.env).catch(() => null)
		]);
		const installed = command != null;
		const loadedText = loaded ? service.loadedText : service.notLoadedText;
		const runtimeShort = formatDaemonRuntimeShort(runtime);
		return {
			label: service.label,
			installed,
			loadedText,
			runtimeShort
		};
	} catch {
		return {
			label: fallbackLabel,
			installed: null,
			loadedText: "unknown",
			runtimeShort: null
		};
	}
}
async function getDaemonStatusSummary() {
	return await buildDaemonStatusSummary(resolveGatewayService(), "Daemon");
}
async function getNodeDaemonStatusSummary() {
	return await buildDaemonStatusSummary(resolveNodeService(), "Node");
}

//#endregion
//#region src/commands/status.gateway-probe.ts
function resolveGatewayProbeAuth(cfg) {
	return resolveGatewayProbeAuth$1({
		cfg,
		mode: cfg.gateway?.mode === "remote" ? "remote" : "local",
		env: process.env
	});
}

//#endregion
//#region src/commands/status.agent-local.ts
async function fileExists(p) {
	try {
		await fs$1.access(p);
		return true;
	} catch {
		return false;
	}
}
async function getAgentLocalStatuses() {
	const cfg = loadConfig();
	const agentList = listAgentsForGateway(cfg);
	const now = Date.now();
	const statuses = [];
	for (const agent of agentList.agents) {
		const agentId = agent.id;
		const workspaceDir = (() => {
			try {
				return resolveAgentWorkspaceDir(cfg, agentId);
			} catch {
				return null;
			}
		})();
		const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
		const bootstrapPending = bootstrapPath != null ? await fileExists(bootstrapPath) : null;
		const sessionsPath = resolveStorePath(cfg.session?.store, { agentId });
		const store = (() => {
			try {
				return loadSessionStore(sessionsPath);
			} catch {
				return {};
			}
		})();
		const sessions = Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([, entry]) => entry);
		const sessionsCount = sessions.length;
		const lastUpdatedAt = sessions.reduce((max, e) => Math.max(max, e?.updatedAt ?? 0), 0);
		const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
		const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;
		statuses.push({
			id: agentId,
			name: agent.name,
			workspaceDir,
			bootstrapPending,
			sessionsPath,
			sessionsCount,
			lastUpdatedAt: resolvedLastUpdatedAt,
			lastActiveAgeMs
		});
	}
	const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
	const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
	return {
		defaultId: agentList.defaultId,
		agents: statuses,
		totalSessions,
		bootstrapPendingCount
	};
}

//#endregion
//#region src/commands/status.link-channel.ts
async function resolveLinkChannelContext(cfg) {
	for (const plugin of listChannelPlugins()) {
		const { defaultAccountId, account, enabled, configured } = await resolveDefaultChannelAccountContext(plugin, cfg);
		const snapshot = plugin.config.describeAccount ? plugin.config.describeAccount(account, cfg) : {
			accountId: defaultAccountId,
			enabled,
			configured
		};
		const summaryRecord = plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
			account,
			cfg,
			defaultAccountId,
			snapshot
		}) : void 0;
		const linked = summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
		if (linked === null) continue;
		return {
			linked,
			authAgeMs: summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null,
			account,
			accountId: defaultAccountId,
			plugin
		};
	}
	return null;
}

//#endregion
//#region src/commands/status.summary.ts
const buildFlags = (entry) => {
	if (!entry) return [];
	const flags = [];
	const think = entry?.thinkingLevel;
	if (typeof think === "string" && think.length > 0) flags.push(`think:${think}`);
	const verbose = entry?.verboseLevel;
	if (typeof verbose === "string" && verbose.length > 0) flags.push(`verbose:${verbose}`);
	const reasoning = entry?.reasoningLevel;
	if (typeof reasoning === "string" && reasoning.length > 0) flags.push(`reasoning:${reasoning}`);
	const elevated = entry?.elevatedLevel;
	if (typeof elevated === "string" && elevated.length > 0) flags.push(`elevated:${elevated}`);
	if (entry?.systemSent) flags.push("system");
	if (entry?.abortedLastRun) flags.push("aborted");
	const sessionId = entry?.sessionId;
	if (typeof sessionId === "string" && sessionId.length > 0) flags.push(`id:${sessionId}`);
	return flags;
};
function redactSensitiveStatusSummary(summary) {
	return {
		...summary,
		sessions: {
			...summary.sessions,
			paths: [],
			defaults: {
				model: null,
				contextTokens: null
			},
			recent: [],
			byAgent: summary.sessions.byAgent.map((entry) => ({
				...entry,
				path: "[redacted]",
				recent: []
			}))
		}
	};
}
async function getStatusSummary(options = {}) {
	const { includeSensitive = true } = options;
	const cfg = loadConfig();
	const linkContext = await resolveLinkChannelContext(cfg);
	const agentList = listAgentsForGateway(cfg);
	const heartbeatAgents = agentList.agents.map((agent) => {
		const summary = resolveHeartbeatSummaryForAgent(cfg, agent.id);
		return {
			agentId: agent.id,
			enabled: summary.enabled,
			every: summary.every,
			everyMs: summary.everyMs
		};
	});
	const channelSummary = await buildChannelSummary(cfg, {
		colorize: true,
		includeAllowFrom: true
	});
	const queuedSystemEvents = peekSystemEvents(resolveMainSessionKey(cfg));
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const configModel = resolved.model ?? DEFAULT_MODEL;
	const configContextTokens = resolveContextTokensForModel({
		cfg,
		provider: resolved.provider ?? DEFAULT_PROVIDER,
		model: configModel,
		contextTokensOverride: cfg.agents?.defaults?.contextTokens,
		fallbackContextTokens: DEFAULT_CONTEXT_TOKENS
	}) ?? DEFAULT_CONTEXT_TOKENS;
	const now = Date.now();
	const storeCache = /* @__PURE__ */ new Map();
	const loadStore = (storePath) => {
		const cached = storeCache.get(storePath);
		if (cached) return cached;
		const store = loadSessionStore(storePath);
		storeCache.set(storePath, store);
		return store;
	};
	const buildSessionRows = (store, opts = {}) => Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([key, entry]) => {
		const updatedAt = entry?.updatedAt ?? null;
		const age = updatedAt ? now - updatedAt : null;
		const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
		const model = resolvedModel.model ?? configModel ?? null;
		const contextTokens = resolveContextTokensForModel({
			cfg,
			provider: resolvedModel.provider,
			model,
			contextTokensOverride: entry?.contextTokens,
			fallbackContextTokens: configContextTokens ?? void 0
		}) ?? null;
		const total = resolveFreshSessionTotalTokens(entry);
		const totalTokensFresh = typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
		const remaining = contextTokens != null && total !== void 0 ? Math.max(0, contextTokens - total) : null;
		const pct = contextTokens && contextTokens > 0 && total !== void 0 ? Math.min(999, Math.round(total / contextTokens * 100)) : null;
		const parsedAgentId = parseAgentSessionKey(key)?.agentId;
		return {
			agentId: opts.agentIdOverride ?? parsedAgentId,
			key,
			kind: classifySessionKey(key, entry),
			sessionId: entry?.sessionId,
			updatedAt,
			age,
			thinkingLevel: entry?.thinkingLevel,
			verboseLevel: entry?.verboseLevel,
			reasoningLevel: entry?.reasoningLevel,
			elevatedLevel: entry?.elevatedLevel,
			systemSent: entry?.systemSent,
			abortedLastRun: entry?.abortedLastRun,
			inputTokens: entry?.inputTokens,
			outputTokens: entry?.outputTokens,
			cacheRead: entry?.cacheRead,
			cacheWrite: entry?.cacheWrite,
			totalTokens: total ?? null,
			totalTokensFresh,
			remainingTokens: remaining,
			percentUsed: pct,
			model,
			contextTokens,
			flags: buildFlags(entry)
		};
	}).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	const paths = /* @__PURE__ */ new Set();
	const byAgent = agentList.agents.map((agent) => {
		const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
		paths.add(storePath);
		const sessions = buildSessionRows(loadStore(storePath), { agentIdOverride: agent.id });
		return {
			agentId: agent.id,
			path: storePath,
			count: sessions.length,
			recent: sessions.slice(0, 10)
		};
	});
	const allSessions = Array.from(paths).flatMap((storePath) => buildSessionRows(loadStore(storePath))).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	const recent = allSessions.slice(0, 10);
	const totalSessions = allSessions.length;
	const summary = {
		linkChannel: linkContext ? {
			id: linkContext.plugin.id,
			label: linkContext.plugin.meta.label ?? "Channel",
			linked: linkContext.linked,
			authAgeMs: linkContext.authAgeMs
		} : void 0,
		heartbeat: {
			defaultAgentId: agentList.defaultId,
			agents: heartbeatAgents
		},
		channelSummary,
		queuedSystemEvents,
		sessions: {
			paths: Array.from(paths),
			count: totalSessions,
			defaults: {
				model: configModel ?? null,
				contextTokens: configContextTokens ?? null
			},
			recent,
			byAgent
		}
	};
	return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}

//#endregion
//#region src/commands/status.scan.ts
function resolveMemoryPluginStatus(cfg) {
	if (!(cfg.plugins?.enabled !== false)) return {
		enabled: false,
		slot: null,
		reason: "plugins disabled"
	};
	const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
	if (raw && raw.toLowerCase() === "none") return {
		enabled: false,
		slot: null,
		reason: "plugins.slots.memory=\"none\""
	};
	return {
		enabled: true,
		slot: raw || "memory-core"
	};
}
async function scanStatus(opts, _runtime) {
	return await withProgress({
		label: "Scanning status…",
		total: 10,
		enabled: opts.json !== true
	}, async (progress) => {
		progress.setLabel("Loading config…");
		const cfg = loadConfig();
		const osSummary = resolveOsSummary();
		progress.tick();
		progress.setLabel("Checking Tailscale…");
		const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
		const tailscaleDns = tailscaleMode === "off" ? null : await getTailnetHostname((cmd, args) => runExec(cmd, args, {
			timeoutMs: 1200,
			maxBuffer: 2e5
		})).catch(() => null);
		const tailscaleHttpsUrl = tailscaleMode !== "off" && tailscaleDns ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}` : null;
		progress.tick();
		progress.setLabel("Checking for updates…");
		const update = await getUpdateCheckResult({
			timeoutMs: opts.all ? 6500 : 2500,
			fetchGit: true,
			includeRegistry: true
		});
		progress.tick();
		progress.setLabel("Resolving agents…");
		const agentStatus = await getAgentLocalStatuses();
		progress.tick();
		progress.setLabel("Probing gateway…");
		const gatewayConnection = buildGatewayConnectionDetails();
		const isRemoteMode = cfg.gateway?.mode === "remote";
		const remoteUrlRaw = typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url : "";
		const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
		const gatewayMode = isRemoteMode ? "remote" : "local";
		const gatewayProbe = remoteUrlMissing ? null : await probeGateway({
			url: gatewayConnection.url,
			auth: resolveGatewayProbeAuth(cfg),
			timeoutMs: Math.min(opts.all ? 5e3 : 2500, opts.timeoutMs ?? 1e4)
		}).catch(() => null);
		const gatewayReachable = gatewayProbe?.ok === true;
		const gatewaySelf = gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null;
		progress.tick();
		progress.setLabel("Querying channel status…");
		const channelsStatus = gatewayReachable ? await callGateway({
			method: "channels.status",
			params: {
				probe: false,
				timeoutMs: Math.min(8e3, opts.timeoutMs ?? 1e4)
			},
			timeoutMs: Math.min(opts.all ? 5e3 : 2500, opts.timeoutMs ?? 1e4)
		}).catch(() => null) : null;
		const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
		progress.tick();
		progress.setLabel("Summarizing channels…");
		const channels = await buildChannelsTable(cfg, { showSecrets: process.env.CLAWDBOT_SHOW_SECRETS?.trim() !== "0" });
		progress.tick();
		progress.setLabel("Checking memory…");
		const memoryPlugin = resolveMemoryPluginStatus(cfg);
		const memory = await (async () => {
			if (!memoryPlugin.enabled) return null;
			if (memoryPlugin.slot !== "memory-core") return null;
			const agentId = agentStatus.defaultId ?? "main";
			const { manager } = await getMemorySearchManager({
				cfg,
				agentId,
				purpose: "status"
			});
			if (!manager) return null;
			try {
				await manager.probeVectorAvailability();
			} catch {}
			const status = manager.status();
			await manager.close?.().catch(() => {});
			return {
				agentId,
				...status
			};
		})();
		progress.tick();
		progress.setLabel("Reading sessions…");
		const summary = await getStatusSummary();
		progress.tick();
		progress.setLabel("Rendering…");
		progress.tick();
		return {
			cfg,
			osSummary,
			tailscaleMode,
			tailscaleDns,
			tailscaleHttpsUrl,
			update,
			gatewayConnection,
			remoteUrlMissing,
			gatewayMode,
			gatewayProbe,
			gatewayReachable,
			gatewaySelf,
			channelIssues,
			agentStatus,
			channels,
			summary,
			memory,
			memoryPlugin
		};
	});
}

//#endregion
//#region src/commands/status.command.ts
function resolvePairingRecoveryContext(params) {
	const sanitizeRequestId = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) return null;
		return trimmed;
	};
	const source = [params.error, params.closeReason].filter((part) => typeof part === "string" && part.trim().length > 0).join(" ");
	if (!source || !/pairing required/i.test(source)) return null;
	const requestIdMatch = source.match(/requestId:\s*([^\s)]+)/i);
	return { requestId: (requestIdMatch && requestIdMatch[1] ? sanitizeRequestId(requestIdMatch[1]) : null) || null };
}
async function statusCommand(opts, runtime) {
	if (opts.all && !opts.json) {
		await statusAllCommand(runtime, { timeoutMs: opts.timeoutMs });
		return;
	}
	const { cfg, osSummary, tailscaleMode, tailscaleDns, tailscaleHttpsUrl, update, gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbe, gatewayReachable, gatewaySelf, channelIssues, agentStatus, channels, summary, memory, memoryPlugin } = await scanStatus({
		json: opts.json,
		timeoutMs: opts.timeoutMs,
		all: opts.all
	}, runtime);
	const securityAudit = await withProgress({
		label: "Running security audit…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await runSecurityAudit({
		config: cfg,
		deep: false,
		includeFilesystem: true,
		includeChannelSecurity: true
	}));
	const usage = opts.usage ? await withProgress({
		label: "Fetching usage snapshot…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await loadProviderUsageSummary({ timeoutMs: opts.timeoutMs })) : void 0;
	const health = opts.deep ? await withProgress({
		label: "Checking gateway health…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "health",
		params: { probe: true },
		timeoutMs: opts.timeoutMs
	})) : void 0;
	const lastHeartbeat = opts.deep && gatewayReachable ? await callGateway({
		method: "last-heartbeat",
		params: {},
		timeoutMs: opts.timeoutMs
	}).catch(() => null) : null;
	const channelInfo = resolveUpdateChannelDisplay({
		configChannel: normalizeUpdateChannel(cfg.update?.channel),
		installKind: update.installKind,
		gitTag: update.git?.tag ?? null,
		gitBranch: update.git?.branch ?? null
	});
	if (opts.json) {
		const [daemon, nodeDaemon] = await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
		runtime.log(JSON.stringify({
			...summary,
			os: osSummary,
			update,
			updateChannel: channelInfo.channel,
			updateChannelSource: channelInfo.source,
			memory,
			memoryPlugin,
			gateway: {
				mode: gatewayMode,
				url: gatewayConnection.url,
				urlSource: gatewayConnection.urlSource,
				misconfigured: remoteUrlMissing,
				reachable: gatewayReachable,
				connectLatencyMs: gatewayProbe?.connectLatencyMs ?? null,
				self: gatewaySelf,
				error: gatewayProbe?.error ?? null
			},
			gatewayService: daemon,
			nodeService: nodeDaemon,
			agents: agentStatus,
			securityAudit,
			...health || usage || lastHeartbeat ? {
				health,
				usage,
				lastHeartbeat
			} : {}
		}, null, 2));
		return;
	}
	const muted = (value) => theme.muted(value);
	const ok = (value) => theme.success(value);
	const warn = (value) => theme.warn(value);
	if (opts.verbose) {
		const details = buildGatewayConnectionDetails();
		runtime.log(info("Gateway connection:"));
		for (const line of details.message.split("\n")) runtime.log(`  ${line}`);
		runtime.log("");
	}
	const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
	const dashboard = (() => {
		if (!(cfg.gateway?.controlUi?.enabled ?? true)) return "disabled";
		return resolveControlUiLinks({
			port: resolveGatewayPort(cfg),
			bind: cfg.gateway?.bind,
			customBindHost: cfg.gateway?.customBindHost,
			basePath: cfg.gateway?.controlUi?.basePath
		}).httpUrl;
	})();
	const gatewayValue = (() => {
		const target = remoteUrlMissing ? `fallback ${gatewayConnection.url}` : `${gatewayConnection.url}${gatewayConnection.urlSource ? ` (${gatewayConnection.urlSource})` : ""}`;
		const reach = remoteUrlMissing ? warn("misconfigured (remote.url missing)") : gatewayReachable ? ok(`reachable ${formatDuration(gatewayProbe?.connectLatencyMs)}`) : warn(gatewayProbe?.error ? `unreachable (${gatewayProbe.error})` : "unreachable");
		const auth = gatewayReachable && !remoteUrlMissing ? ` · auth ${formatGatewayAuthUsed(resolveGatewayProbeAuth(cfg))}` : "";
		const self = gatewaySelf?.host || gatewaySelf?.version || gatewaySelf?.platform ? [
			gatewaySelf?.host ? gatewaySelf.host : null,
			gatewaySelf?.ip ? `(${gatewaySelf.ip})` : null,
			gatewaySelf?.version ? `app ${gatewaySelf.version}` : null,
			gatewaySelf?.platform ? gatewaySelf.platform : null
		].filter(Boolean).join(" ") : null;
		return `${gatewayMode} · ${target} · ${reach}${auth}${self ? ` · ${self}` : ""}`;
	})();
	const pairingRecovery = resolvePairingRecoveryContext({
		error: gatewayProbe?.error ?? null,
		closeReason: gatewayProbe?.close?.reason ?? null
	});
	const agentsValue = (() => {
		const pending = agentStatus.bootstrapPendingCount > 0 ? `${agentStatus.bootstrapPendingCount} bootstrap file${agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present` : "no bootstrap files";
		const def = agentStatus.agents.find((a) => a.id === agentStatus.defaultId);
		const defActive = def?.lastActiveAgeMs != null ? formatTimeAgo(def.lastActiveAgeMs) : "unknown";
		const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
		return `${agentStatus.agents.length} · ${pending} · sessions ${agentStatus.totalSessions}${defSuffix}`;
	})();
	const [daemon, nodeDaemon] = await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
	const daemonValue = (() => {
		if (daemon.installed === false) return `${daemon.label} not installed`;
		const installedPrefix = daemon.installed === true ? "installed · " : "";
		return `${daemon.label} ${installedPrefix}${daemon.loadedText}${daemon.runtimeShort ? ` · ${daemon.runtimeShort}` : ""}`;
	})();
	const nodeDaemonValue = (() => {
		if (nodeDaemon.installed === false) return `${nodeDaemon.label} not installed`;
		const installedPrefix = nodeDaemon.installed === true ? "installed · " : "";
		return `${nodeDaemon.label} ${installedPrefix}${nodeDaemon.loadedText}${nodeDaemon.runtimeShort ? ` · ${nodeDaemon.runtimeShort}` : ""}`;
	})();
	const defaults = summary.sessions.defaults;
	const defaultCtx = defaults.contextTokens ? ` (${formatKTokens(defaults.contextTokens)} ctx)` : "";
	const eventsValue = summary.queuedSystemEvents.length > 0 ? `${summary.queuedSystemEvents.length} queued` : "none";
	const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");
	const heartbeatValue = (() => {
		const parts = summary.heartbeat.agents.map((agent) => {
			if (!agent.enabled || !agent.everyMs) return `disabled (${agent.agentId})`;
			return `${agent.every} (${agent.agentId})`;
		}).filter(Boolean);
		return parts.length > 0 ? parts.join(", ") : "disabled";
	})();
	const lastHeartbeatValue = (() => {
		if (!opts.deep) return null;
		if (!gatewayReachable) return warn("unavailable");
		if (!lastHeartbeat) return muted("none");
		const age = formatTimeAgo(Date.now() - lastHeartbeat.ts);
		const channel = lastHeartbeat.channel ?? "unknown";
		const accountLabel = lastHeartbeat.accountId ? `account ${lastHeartbeat.accountId}` : null;
		return [
			lastHeartbeat.status,
			`${age} ago`,
			channel,
			accountLabel
		].filter(Boolean).join(" · ");
	})();
	const storeLabel = summary.sessions.paths.length > 1 ? `${summary.sessions.paths.length} stores` : summary.sessions.paths[0] ?? "unknown";
	const memoryValue = (() => {
		if (!memoryPlugin.enabled) return muted(`disabled${memoryPlugin.reason ? ` (${memoryPlugin.reason})` : ""}`);
		if (!memory) {
			const slot = memoryPlugin.slot ? `plugin ${memoryPlugin.slot}` : "plugin";
			if (memoryPlugin.slot && memoryPlugin.slot !== "memory-core") return `enabled (${slot})`;
			return muted(`enabled (${slot}) · unavailable`);
		}
		const parts = [];
		const dirtySuffix = memory.dirty ? ` · ${warn("dirty")}` : "";
		parts.push(`${memory.files} files · ${memory.chunks} chunks${dirtySuffix}`);
		if (memory.sources?.length) parts.push(`sources ${memory.sources.join(", ")}`);
		if (memoryPlugin.slot) parts.push(`plugin ${memoryPlugin.slot}`);
		const colorByTone = (tone, text) => tone === "ok" ? ok(text) : tone === "warn" ? warn(text) : muted(text);
		const vector = memory.vector;
		if (vector) {
			const state = resolveMemoryVectorState(vector);
			const label = state.state === "disabled" ? "vector off" : `vector ${state.state}`;
			parts.push(colorByTone(state.tone, label));
		}
		const fts = memory.fts;
		if (fts) {
			const state = resolveMemoryFtsState(fts);
			const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
			parts.push(colorByTone(state.tone, label));
		}
		const cache = memory.cache;
		if (cache) {
			const summary = resolveMemoryCacheSummary(cache);
			parts.push(colorByTone(summary.tone, summary.text));
		}
		return parts.join(" · ");
	})();
	const updateAvailability = resolveUpdateAvailability(update);
	const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
	const channelLabel = channelInfo.label;
	const gitLabel = formatGitInstallLabel(update);
	const overviewRows = [
		{
			Item: "Dashboard",
			Value: dashboard
		},
		{
			Item: "OS",
			Value: `${osSummary.label} · node ${process.versions.node}`
		},
		{
			Item: "Tailscale",
			Value: tailscaleMode === "off" ? muted("off") : tailscaleDns && tailscaleHttpsUrl ? `${tailscaleMode} · ${tailscaleDns} · ${tailscaleHttpsUrl}` : warn(`${tailscaleMode} · magicdns unknown`)
		},
		{
			Item: "Channel",
			Value: channelLabel
		},
		...gitLabel ? [{
			Item: "Git",
			Value: gitLabel
		}] : [],
		{
			Item: "Update",
			Value: updateAvailability.available ? warn(`available · ${updateLine}`) : updateLine
		},
		{
			Item: "Gateway",
			Value: gatewayValue
		},
		{
			Item: "Gateway service",
			Value: daemonValue
		},
		{
			Item: "Node service",
			Value: nodeDaemonValue
		},
		{
			Item: "Agents",
			Value: agentsValue
		},
		{
			Item: "Memory",
			Value: memoryValue
		},
		{
			Item: "Probes",
			Value: probesValue
		},
		{
			Item: "Events",
			Value: eventsValue
		},
		{
			Item: "Heartbeat",
			Value: heartbeatValue
		},
		...lastHeartbeatValue ? [{
			Item: "Last heartbeat",
			Value: lastHeartbeatValue
		}] : [],
		{
			Item: "Sessions",
			Value: `${summary.sessions.count} active · default ${defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`
		}
	];
	runtime.log(theme.heading("OpenClaw status"));
	runtime.log("");
	runtime.log(theme.heading("Overview"));
	runtime.log(renderTable({
		width: tableWidth,
		columns: [{
			key: "Item",
			header: "Item",
			minWidth: 12
		}, {
			key: "Value",
			header: "Value",
			flex: true,
			minWidth: 32
		}],
		rows: overviewRows
	}).trimEnd());
	if (pairingRecovery) {
		runtime.log("");
		runtime.log(theme.warn("Gateway pairing approval required."));
		if (pairingRecovery.requestId) runtime.log(theme.muted(`Recovery: ${formatCliCommand(`openclaw devices approve ${pairingRecovery.requestId}`)}`));
		runtime.log(theme.muted(`Fallback: ${formatCliCommand("openclaw devices approve --latest")}`));
		runtime.log(theme.muted(`Inspect: ${formatCliCommand("openclaw devices list")}`));
	}
	runtime.log("");
	runtime.log(theme.heading("Security audit"));
	const fmtSummary = (value) => {
		return [
			theme.error(`${value.critical} critical`),
			theme.warn(`${value.warn} warn`),
			theme.muted(`${value.info} info`)
		].join(" · ");
	};
	runtime.log(theme.muted(`Summary: ${fmtSummary(securityAudit.summary)}`));
	const importantFindings = securityAudit.findings.filter((f) => f.severity === "critical" || f.severity === "warn");
	if (importantFindings.length === 0) runtime.log(theme.muted("No critical or warn findings detected."));
	else {
		const severityLabel = (sev) => {
			if (sev === "critical") return theme.error("CRITICAL");
			if (sev === "warn") return theme.warn("WARN");
			return theme.muted("INFO");
		};
		const sevRank = (sev) => sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
		const sorted = [...importantFindings].toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity));
		const shown = sorted.slice(0, 6);
		for (const f of shown) {
			runtime.log(`  ${severityLabel(f.severity)} ${f.title}`);
			runtime.log(`    ${shortenText(f.detail.replaceAll("\n", " "), 160)}`);
			if (f.remediation?.trim()) runtime.log(`    ${theme.muted(`Fix: ${f.remediation.trim()}`)}`);
		}
		if (sorted.length > shown.length) runtime.log(theme.muted(`… +${sorted.length - shown.length} more`));
	}
	runtime.log(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
	runtime.log(theme.muted(`Deep probe: ${formatCliCommand("openclaw security audit --deep")}`));
	runtime.log("");
	runtime.log(theme.heading("Channels"));
	const channelIssuesByChannel = (() => {
		const map = /* @__PURE__ */ new Map();
		for (const issue of channelIssues) {
			const key = issue.channel;
			const list = map.get(key);
			if (list) list.push(issue);
			else map.set(key, [issue]);
		}
		return map;
	})();
	runtime.log(renderTable({
		width: tableWidth,
		columns: [
			{
				key: "Channel",
				header: "Channel",
				minWidth: 10
			},
			{
				key: "Enabled",
				header: "Enabled",
				minWidth: 7
			},
			{
				key: "State",
				header: "State",
				minWidth: 8
			},
			{
				key: "Detail",
				header: "Detail",
				flex: true,
				minWidth: 24
			}
		],
		rows: channels.rows.map((row) => {
			const issues = channelIssuesByChannel.get(row.id) ?? [];
			const effectiveState = row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
			const issueSuffix = issues.length > 0 ? ` · ${warn(`gateway: ${shortenText(issues[0]?.message ?? "issue", 84)}`)}` : "";
			return {
				Channel: row.label,
				Enabled: row.enabled ? ok("ON") : muted("OFF"),
				State: effectiveState === "ok" ? ok("OK") : effectiveState === "warn" ? warn("WARN") : effectiveState === "off" ? muted("OFF") : theme.accentDim("SETUP"),
				Detail: `${row.detail}${issueSuffix}`
			};
		})
	}).trimEnd());
	runtime.log("");
	runtime.log(theme.heading("Sessions"));
	runtime.log(renderTable({
		width: tableWidth,
		columns: [
			{
				key: "Key",
				header: "Key",
				minWidth: 20,
				flex: true
			},
			{
				key: "Kind",
				header: "Kind",
				minWidth: 6
			},
			{
				key: "Age",
				header: "Age",
				minWidth: 9
			},
			{
				key: "Model",
				header: "Model",
				minWidth: 14
			},
			{
				key: "Tokens",
				header: "Tokens",
				minWidth: 16
			}
		],
		rows: summary.sessions.recent.length > 0 ? summary.sessions.recent.map((sess) => ({
			Key: shortenText(sess.key, 32),
			Kind: sess.kind,
			Age: sess.updatedAt ? formatTimeAgo(sess.age) : "no activity",
			Model: sess.model ?? "unknown",
			Tokens: formatTokensCompact(sess)
		})) : [{
			Key: muted("no sessions yet"),
			Kind: "",
			Age: "",
			Model: "",
			Tokens: ""
		}]
	}).trimEnd());
	if (summary.queuedSystemEvents.length > 0) {
		runtime.log("");
		runtime.log(theme.heading("System events"));
		runtime.log(renderTable({
			width: tableWidth,
			columns: [{
				key: "Event",
				header: "Event",
				flex: true,
				minWidth: 24
			}],
			rows: summary.queuedSystemEvents.slice(0, 5).map((event) => ({ Event: event }))
		}).trimEnd());
		if (summary.queuedSystemEvents.length > 5) runtime.log(muted(`… +${summary.queuedSystemEvents.length - 5} more`));
	}
	if (health) {
		runtime.log("");
		runtime.log(theme.heading("Health"));
		const rows = [];
		rows.push({
			Item: "Gateway",
			Status: ok("reachable"),
			Detail: `${health.durationMs}ms`
		});
		for (const line of formatHealthChannelLines(health, { accountMode: "all" })) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			const item = line.slice(0, colon).trim();
			const detail = line.slice(colon + 1).trim();
			const normalized = detail.toLowerCase();
			const status = (() => {
				if (normalized.startsWith("ok")) return ok("OK");
				if (normalized.startsWith("failed")) return warn("WARN");
				if (normalized.startsWith("not configured")) return muted("OFF");
				if (normalized.startsWith("configured")) return ok("OK");
				if (normalized.startsWith("linked")) return ok("LINKED");
				if (normalized.startsWith("not linked")) return warn("UNLINKED");
				return warn("WARN");
			})();
			rows.push({
				Item: item,
				Status: status,
				Detail: detail
			});
		}
		runtime.log(renderTable({
			width: tableWidth,
			columns: [
				{
					key: "Item",
					header: "Item",
					minWidth: 10
				},
				{
					key: "Status",
					header: "Status",
					minWidth: 8
				},
				{
					key: "Detail",
					header: "Detail",
					flex: true,
					minWidth: 28
				}
			],
			rows
		}).trimEnd());
	}
	if (usage) {
		runtime.log("");
		runtime.log(theme.heading("Usage"));
		for (const line of formatUsageReportLines(usage)) runtime.log(line);
	}
	runtime.log("");
	runtime.log("FAQ: https://docs.openclaw.ai/faq");
	runtime.log("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
	runtime.log("");
	const updateHint = formatUpdateAvailableHint(update);
	if (updateHint) {
		runtime.log(theme.warn(updateHint));
		runtime.log("");
	}
	runtime.log("Next steps:");
	runtime.log(`  Need to share?      ${formatCliCommand("openclaw status --all")}`);
	runtime.log(`  Need to debug live? ${formatCliCommand("openclaw logs --follow")}`);
	if (gatewayReachable) runtime.log(`  Need to test channels? ${formatCliCommand("openclaw status --deep")}`);
	else runtime.log(`  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`);
}

//#endregion
//#region src/commands/status.ts
var status_exports = /* @__PURE__ */ __exportAll({ statusCommand: () => statusCommand });

//#endregion
export { pickGatewaySelfPresence as i, statusCommand as n, getStatusSummary as r, status_exports as t };