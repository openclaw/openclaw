import { n as info } from "./globals-I5DlBD2D.js";
import { u as resolveGatewayPort } from "./paths-1qR_mW4i.js";
import { n as isRich, r as theme } from "./theme-UkqnBJaj.js";
import { Bd as callGateway, Er as getRemoteSkillEligibility, Ha as resolveCommandSecretRefsViaGateway, Ub as readBestEffortConfig, Wb as readConfigFileSnapshot, ZS as hasPotentialConfiguredChannels, cd as resolveControlUiLinks, co as readRestartSentinel, hd as normalizeControlUiBasePath, im as loadSessionStore, lo as summarizeRestartSentinel, nn as withProgress, zd as buildGatewayConnectionDetails } from "./auth-profiles-DqxBs6Au.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-0nFkqMDM.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { d as resolveAgentWorkspaceDir } from "./agent-scope-tkfLX5MZ.js";
import { n as runExec } from "./exec-Fh3CK0qE.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import { R as readTailscaleStatusJson } from "./config-VO8zzMSR.js";
import { s as getStatusCommandSecretTargetIds } from "./command-secret-targets-7sQA1Mwd.js";
import { a as inspectPortUsage, c as formatPortDiagnostics } from "./ports-DeHp-MTZ.js";
import { l as resolveStorePath } from "./paths-YN5WLIkL.js";
import { l as formatDurationPrecise, o as formatTimeAgo } from "./account-summary-DtY_0EC1.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BI0f8wZY.js";
import { c as resolveGatewayLogPaths } from "./launchd-BbDrm470.js";
import { n as resolveGatewayService } from "./service-DC_Pq39i.js";
import { t as probeGateway } from "./probe-ukFJg9oz.js";
import { t as formatConfigIssueLine } from "./issue-format-B2YddtHw.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-C5x1GrBv.js";
import { n as resolveGatewayProbeAuthSafe } from "./probe-auth-BWPIo_kJ.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-BnGfb4xp.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BFTFgs1v.js";
import { a as getNodeDaemonStatusSummary, c as formatTokensCompact, d as resolveOsSummary, f as pickGatewaySelfPresence, i as getDaemonStatusSummary, l as readServiceStatusSummary, n as resolveGatewayProbeAuthResolution, o as formatDuration, r as getAgentLocalStatuses$1, s as formatKTokens, t as getStatusSummary, u as listGatewayAgentsBasic } from "./status.summary-BuyxSRkJ.js";
import { t as formatHealthChannelLines } from "./health-D7ZxsaPF.js";
import { h as resolveUpdateChannelDisplay, i as formatGitInstallLabel, p as normalizeUpdateChannel, t as checkUpdateStatus } from "./update-check-CC-MBAhO.js";
import { t as resolveNodeService } from "./node-service-CIvdubGS.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-DH9mhah5.js";
import { n as redactSecrets, t as formatGatewayAuthUsed } from "./format-D2nAG4Q5.js";
import { t as buildChannelsTable } from "./channels-BlNGHvlP.js";
import { i as resolveUpdateAvailability, n as formatUpdateOneLiner, r as getUpdateCheckResult, t as formatUpdateAvailableHint } from "./status.update-DcHXsERE.js";
import { t as shortenText } from "./text-format-D0hpaJy5.js";
import { existsSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/memory/status-format.ts
function resolveMemoryVectorState(vector) {
	if (!vector.enabled) {return {
		tone: "muted",
		state: "disabled"
	};}
	if (vector.available === true) {return {
		tone: "ok",
		state: "ready"
	};}
	if (vector.available === false) {return {
		tone: "warn",
		state: "unavailable"
	};}
	return {
		tone: "muted",
		state: "unknown"
	};
}
function resolveMemoryFtsState(fts) {
	if (!fts.enabled) {return {
		tone: "muted",
		state: "disabled"
	};}
	return fts.available ? {
		tone: "ok",
		state: "ready"
	} : {
		tone: "warn",
		state: "unavailable"
	};
}
function resolveMemoryCacheSummary(cache) {
	if (!cache.enabled) {return {
		tone: "muted",
		text: "cache off"
	};}
	return {
		tone: "ok",
		text: `cache on${typeof cache.entries === "number" ? ` (${cache.entries})` : ""}`
	};
}
//#endregion
//#region src/commands/status-all/agents.ts
async function fileExists(p) {
	try {
		await fs$1.access(p);
		return true;
	} catch {
		return false;
	}
}
async function getAgentLocalStatuses(cfg) {
	const agentList = listGatewayAgentsBasic(cfg);
	const now = Date.now();
	const agents = await Promise.all(agentList.agents.map(async (agent) => {
		const workspaceDir = (() => {
			try {
				return resolveAgentWorkspaceDir(cfg, agent.id);
			} catch {
				return null;
			}
		})();
		const bootstrapPending = workspaceDir != null ? await fileExists(path.join(workspaceDir, "BOOTSTRAP.md")) : null;
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
//#region src/commands/status-all/gateway.ts
async function readFileTailLines(filePath, maxLines) {
	const raw = await fs$1.readFile(filePath, "utf8").catch(() => "");
	if (!raw.trim()) {return [];}
	const lines = raw.replace(/\r/g, "").split("\n");
	return lines.slice(Math.max(0, lines.length - maxLines)).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}
function countMatches(haystack, needle) {
	if (!haystack || !needle) {return 0;}
	return haystack.split(needle).length - 1;
}
function shorten(message, maxLen) {
	const cleaned = message.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxLen) {return cleaned;}
	return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}
function normalizeGwsLine(line) {
	return line.replace(/\s+runId=[^\s]+/g, "").replace(/\s+conn=[^\s]+/g, "").replace(/\s+id=[^\s]+/g, "").replace(/\s+error=Error:.*$/g, "").trim();
}
function consumeJsonBlock(lines, startIndex) {
	const startLine = lines[startIndex] ?? "";
	const braceAt = startLine.indexOf("{");
	if (braceAt < 0) {return null;}
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
		if (!trimmed) {return;}
		out.push(trimmed);
	};
	const lines = rawLines.map((line) => line.trimEnd()).filter(Boolean);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const trimmedStart = line.trimStart();
		if ((trimmedStart.startsWith("\"") || trimmedStart === "}" || trimmedStart === "{" || trimmedStart.startsWith("}") || trimmedStart.startsWith("{")) && !trimmedStart.startsWith("[") && !trimmedStart.startsWith("#")) {continue;}
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
		if (g.count <= 1) {continue;}
		out[g.index] = `${g.base} ×${g.count}`;
	}
	const deduped = [];
	for (const line of out) {
		if (deduped[deduped.length - 1] === line) {continue;}
		deduped.push(line);
	}
	if (deduped.length <= maxLines) {return deduped;}
	const head = Math.min(6, Math.floor(maxLines / 3));
	const tail = Math.max(1, maxLines - head - 1);
	return [
		...deduped.slice(0, head),
		`… ${deduped.length - head - tail} lines omitted …`,
		...deduped.slice(-tail)
	];
}
//#endregion
//#region src/commands/status-all/channel-issues.ts
function groupChannelIssuesByChannel(issues) {
	const byChannel = /* @__PURE__ */ new Map();
	for (const issue of issues) {
		const key = issue.channel;
		const list = byChannel.get(key);
		if (list) {list.push(issue);}
		else {byChannel.set(key, [issue]);}
	}
	return byChannel;
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
	for (const line of redactSecrets(params.connectionDetailsForReport).split("\n").map((l) => l.trimEnd())) {lines.push(`  ${muted(line)}`);}
	lines.push("");
	if (params.snap) {
		const status = !params.snap.exists ? "fail" : params.snap.valid ? "ok" : "warn";
		emitCheck(`Config: ${params.snap.path ?? "(unknown)"}`, status);
		const issues = [...params.snap.legacyIssues ?? [], ...params.snap.issues ?? []];
		const uniqueIssues = issues.filter((issue, index) => issues.findIndex((x) => x.path === issue.path && x.message === issue.message) === index);
		for (const issue of uniqueIssues.slice(0, 12)) {lines.push(`  ${formatConfigIssueLine(issue, "-")}`);}
		if (uniqueIssues.length > 12) {lines.push(`  ${muted(`… +${uniqueIssues.length - 12} more`)}`);}
	} else {emitCheck("Config: read failed", "warn");}
	if (params.remoteUrlMissing) {
		lines.push("");
		emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
		lines.push(`  ${muted("Fix: set gateway.remote.url, or set gateway.mode=local.")}`);
	}
	if (params.sentinel?.payload) {
		emitCheck("Restart sentinel present", "warn");
		lines.push(`  ${muted(`${summarizeRestartSentinel(params.sentinel.payload)} · ${formatTimeAgo(Date.now() - params.sentinel.payload.ts)}`)}`);
	} else {emitCheck("Restart sentinel: none", "ok");}
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
		if (!portOk) {for (const line of formatPortDiagnostics(params.portUsage)) lines.push(`  ${muted(line)}`);}
	}
	{
		const backend = params.tailscale.backendState ?? "unknown";
		const okBackend = backend === "Running";
		const hasDns = Boolean(params.tailscale.dnsName);
		emitCheck(params.tailscaleMode === "off" ? `Tailscale: off · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}` : `Tailscale: ${params.tailscaleMode} · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}`, okBackend && (params.tailscaleMode === "off" || hasDns) ? "ok" : "warn");
		if (params.tailscale.error) {lines.push(`  ${muted(`error: ${params.tailscale.error}`)}`);}
		if (params.tailscale.ips.length > 0) {lines.push(`  ${muted(`ips: ${params.tailscale.ips.slice(0, 3).join(", ")}${params.tailscale.ips.length > 3 ? "…" : ""}`)}`);}
		if (params.tailscaleHttpsUrl) {lines.push(`  ${muted(`https: ${params.tailscaleHttpsUrl}`)}`);}
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
			for (const line of summarizeLogTail(stderrTail, { maxLines: 22 }).map(redactSecrets)) {lines.push(`  ${muted(line)}`);}
			lines.push(`  ${muted(`# stdout: ${logPaths.stdoutPath}`)}`);
			for (const line of summarizeLogTail(stdoutTail, { maxLines: 22 }).map(redactSecrets)) {lines.push(`  ${muted(line)}`);}
		}
	}
	params.progress.tick();
	if (params.channelsStatus) {
		emitCheck(`Channel issues (${params.channelIssues.length || "none"})`, params.channelIssues.length === 0 ? "ok" : "warn");
		for (const issue of params.channelIssues.slice(0, 12)) {
			const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
			lines.push(`  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`);
		}
		if (params.channelIssues.length > 12) {lines.push(`  ${muted(`… +${params.channelIssues.length - 12} more`)}`);}
	} else {emitCheck(`Channel issues skipped (gateway ${params.gatewayReachable ? "query failed" : "unreachable"})`, "warn");}
	const healthErr = (() => {
		if (!params.health || typeof params.health !== "object") {return "";}
		const record = params.health;
		if (!("error" in record)) {return "";}
		const value = record.error;
		if (!value) {return "";}
		if (typeof value === "string") {return value;}
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
	const tableWidth = getTerminalTableWidth();
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
	const channelIssuesByChannel = groupChannelIssuesByChannel(params.channelIssues);
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
			if (issues.length === 0) {return row;}
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
		const loadedRaw = await readBestEffortConfig();
		const { resolvedConfig: cfg } = await resolveCommandSecretRefsViaGateway({
			config: loadedRaw,
			commandName: "status --all",
			targetIds: getStatusCommandSecretTargetIds(),
			mode: "read_only_status"
		});
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
		const localProbeAuthResolution = resolveGatewayProbeAuthSafe({
			cfg,
			mode: "local"
		});
		const remoteProbeAuthResolution = resolveGatewayProbeAuthSafe({
			cfg,
			mode: "remote"
		});
		const probeAuthResolution = isRemoteMode && !remoteUrlMissing ? remoteProbeAuthResolution : localProbeAuthResolution;
		const probeAuth = probeAuthResolution.auth;
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
				const summary = await readServiceStatusSummary(service, service.label);
				return {
					label: summary.label,
					installed: summary.installed,
					managedByOpenClaw: summary.managedByOpenClaw,
					loaded: summary.loaded,
					loadedText: summary.loadedText,
					runtime: summary.runtime
				};
			} catch {
				return null;
			}
		};
		const daemon = await readServiceSummary(resolveGatewayService());
		const nodeService = await readServiceSummary(resolveNodeService());
		progress.tick();
		progress.setLabel("Scanning agents…");
		const agentStatus = await getAgentLocalStatuses(cfg);
		progress.tick();
		progress.setLabel("Summarizing channels…");
		const channels = await buildChannelsTable(cfg, {
			showSecrets: false,
			sourceConfig: loadedRaw
		});
		progress.tick();
		const connectionDetailsForReport = (() => {
			if (!remoteUrlMissing) {return connection.message;}
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
			token: localProbeAuthResolution.auth.token,
			password: localProbeAuthResolution.auth.password
		} : {};
		progress.setLabel("Querying gateway…");
		const health = gatewayReachable ? await callGateway({
			config: cfg,
			method: "health",
			timeoutMs: Math.min(8e3, opts?.timeoutMs ?? 1e4),
			...callOverrides
		}).catch((err) => ({ error: String(err) })) : { error: gatewayProbe?.error ?? "gateway unreachable" };
		const channelsStatus = gatewayReachable ? await callGateway({
			config: cfg,
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
				...probeAuthResolution.warning ? [{
					Item: "Gateway auth warning",
					Value: probeAuthResolution.warning
				}] : [],
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
					Value: !daemon.installed ? `${daemon.label} not installed` : `${daemon.label} ${daemon.managedByOpenClaw ? "installed · " : ""}${daemon.loadedText}${daemon.runtime?.status ? ` · ${daemon.runtime.status}` : ""}${daemon.runtime?.pid ? ` (pid ${daemon.runtime.pid})` : ""}`
				} : {
					Item: "Gateway service",
					Value: "unknown"
				},
				nodeService ? {
					Item: "Node service",
					Value: !nodeService.installed ? `${nodeService.label} not installed` : `${nodeService.label} ${nodeService.managedByOpenClaw ? "installed · " : ""}${nodeService.loadedText}${nodeService.runtime?.status ? ` · ${nodeService.runtime.status}` : ""}${nodeService.runtime?.pid ? ` (pid ${nodeService.runtime.pid})` : ""}`
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
//#region src/commands/status.scan.ts
function hasExplicitMemorySearchConfig(cfg, agentId) {
	if (cfg.agents?.defaults && Object.prototype.hasOwnProperty.call(cfg.agents.defaults, "memorySearch")) {return true;}
	return (Array.isArray(cfg.agents?.list) ? cfg.agents.list : []).some((agent) => agent?.id === agentId && Object.prototype.hasOwnProperty.call(agent, "memorySearch"));
}
let pluginRegistryModulePromise;
let statusScanRuntimeModulePromise;
let statusScanDepsRuntimeModulePromise;
function loadPluginRegistryModule() {
	pluginRegistryModulePromise ??= import("./plugin-registry-CC5xtqyE.js");
	return pluginRegistryModulePromise;
}
function loadStatusScanRuntimeModule() {
	statusScanRuntimeModulePromise ??= import("./status.scan.runtime-CT0HFv3w.js");
	return statusScanRuntimeModulePromise;
}
function loadStatusScanDepsRuntimeModule() {
	statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime-Dv1R_Shj.js");
	return statusScanDepsRuntimeModulePromise;
}
function deferResult(promise) {
	return promise.then((value) => ({
		ok: true,
		value
	}), (error) => ({
		ok: false,
		error
	}));
}
function unwrapDeferredResult(result) {
	if (!result.ok) {throw result.error;}
	return result.value;
}
function resolveMemoryPluginStatus(cfg) {
	if (!(cfg.plugins?.enabled !== false)) {return {
		enabled: false,
		slot: null,
		reason: "plugins disabled"
	};}
	const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
	if (raw && raw.toLowerCase() === "none") {return {
		enabled: false,
		slot: null,
		reason: "plugins.slots.memory=\"none\""
	};}
	return {
		enabled: true,
		slot: raw || "memory-core"
	};
}
async function resolveGatewayProbeSnapshot(params) {
	const gatewayConnection = buildGatewayConnectionDetails({ config: params.cfg });
	const isRemoteMode = params.cfg.gateway?.mode === "remote";
	const remoteUrlRaw = typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url : "";
	const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
	const gatewayMode = isRemoteMode ? "remote" : "local";
	const gatewayProbeAuthResolution = resolveGatewayProbeAuthResolution(params.cfg);
	let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
	const gatewayProbe = remoteUrlMissing ? null : await probeGateway({
		url: gatewayConnection.url,
		auth: gatewayProbeAuthResolution.auth,
		timeoutMs: Math.min(params.opts.all ? 5e3 : 2500, params.opts.timeoutMs ?? 1e4),
		detailLevel: "presence"
	}).catch(() => null);
	if (gatewayProbeAuthWarning && gatewayProbe?.ok === false) {
		gatewayProbe.error = gatewayProbe.error ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}` : gatewayProbeAuthWarning;
		gatewayProbeAuthWarning = void 0;
	}
	return {
		gatewayConnection,
		remoteUrlMissing,
		gatewayMode,
		gatewayProbeAuth: gatewayProbeAuthResolution.auth,
		gatewayProbeAuthWarning,
		gatewayProbe
	};
}
async function resolveChannelsStatus(params) {
	if (!params.gatewayReachable) {return null;}
	return await callGateway({
		config: params.cfg,
		method: "channels.status",
		params: {
			probe: false,
			timeoutMs: Math.min(8e3, params.opts.timeoutMs ?? 1e4)
		},
		timeoutMs: Math.min(params.opts.all ? 5e3 : 2500, params.opts.timeoutMs ?? 1e4)
	}).catch(() => null);
}
async function resolveMemoryStatusSnapshot(params) {
	const { cfg, agentStatus, memoryPlugin } = params;
	if (!memoryPlugin.enabled) {return null;}
	if (memoryPlugin.slot !== "memory-core") {return null;}
	const agentId = agentStatus.defaultId ?? "main";
	const resolvedMemory = resolveMemorySearchConfig(cfg, agentId);
	if (!resolvedMemory) {return null;}
	if (!(hasExplicitMemorySearchConfig(cfg, agentId) || existsSync(resolvedMemory.store.path))) {return null;}
	const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
	const { manager } = await getMemorySearchManager({
		cfg,
		agentId,
		purpose: "status"
	});
	if (!manager) {return null;}
	try {
		await manager.probeVectorAvailability();
	} catch {}
	const status = manager.status();
	await manager.close?.().catch(() => {});
	return {
		agentId,
		...status
	};
}
async function scanStatusJsonFast(opts) {
	const loadedRaw = await readBestEffortConfig();
	const { resolvedConfig: cfg, diagnostics: secretDiagnostics } = await resolveCommandSecretRefsViaGateway({
		config: loadedRaw,
		commandName: "status --json",
		targetIds: getStatusCommandSecretTargetIds(),
		mode: "read_only_status"
	});
	if (hasPotentialConfiguredChannels(cfg)) {
		const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
		ensurePluginRegistryLoaded({ scope: "configured-channels" });
	}
	const osSummary = resolveOsSummary();
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	const updatePromise = getUpdateCheckResult({
		timeoutMs: opts.all ? 6500 : 2500,
		fetchGit: true,
		includeRegistry: true
	});
	const agentStatusPromise = getAgentLocalStatuses$1(cfg);
	const summaryPromise = getStatusSummary({
		config: cfg,
		sourceConfig: loadedRaw
	});
	const tailscaleDnsPromise = tailscaleMode === "off" ? Promise.resolve(null) : loadStatusScanDepsRuntimeModule().then(({ getTailnetHostname }) => getTailnetHostname((cmd, args) => runExec(cmd, args, {
		timeoutMs: 1200,
		maxBuffer: 2e5
	}))).catch(() => null);
	const gatewayProbePromise = resolveGatewayProbeSnapshot({
		cfg,
		opts
	});
	const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
		tailscaleDnsPromise,
		updatePromise,
		agentStatusPromise,
		gatewayProbePromise,
		summaryPromise
	]);
	const tailscaleHttpsUrl = tailscaleMode !== "off" && tailscaleDns ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}` : null;
	const { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbeAuth, gatewayProbeAuthWarning, gatewayProbe } = gatewaySnapshot;
	const gatewayReachable = gatewayProbe?.ok === true;
	const gatewaySelf = gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null;
	const memoryPlugin = resolveMemoryPluginStatus(cfg);
	return {
		cfg,
		sourceConfig: loadedRaw,
		secretDiagnostics,
		osSummary,
		tailscaleMode,
		tailscaleDns,
		tailscaleHttpsUrl,
		update,
		gatewayConnection,
		remoteUrlMissing,
		gatewayMode,
		gatewayProbeAuth,
		gatewayProbeAuthWarning,
		gatewayProbe,
		gatewayReachable,
		gatewaySelf,
		channelIssues: [],
		agentStatus,
		channels: {
			rows: [],
			details: []
		},
		summary,
		memory: await resolveMemoryStatusSnapshot({
			cfg,
			agentStatus,
			memoryPlugin
		}),
		memoryPlugin
	};
}
async function scanStatus(opts, _runtime) {
	if (opts.json) {return await scanStatusJsonFast({
		timeoutMs: opts.timeoutMs,
		all: opts.all
	});}
	return await withProgress({
		label: "Scanning status…",
		total: 10,
		enabled: true
	}, async (progress) => {
		progress.setLabel("Loading config…");
		const loadedRaw = await readBestEffortConfig();
		const { resolvedConfig: cfg, diagnostics: secretDiagnostics } = await resolveCommandSecretRefsViaGateway({
			config: loadedRaw,
			commandName: "status",
			targetIds: getStatusCommandSecretTargetIds(),
			mode: "read_only_status"
		});
		const osSummary = resolveOsSummary();
		const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
		const tailscaleDnsPromise = tailscaleMode === "off" ? Promise.resolve(null) : loadStatusScanDepsRuntimeModule().then(({ getTailnetHostname }) => getTailnetHostname((cmd, args) => runExec(cmd, args, {
			timeoutMs: 1200,
			maxBuffer: 2e5
		}))).catch(() => null);
		const updatePromise = deferResult(getUpdateCheckResult({
			timeoutMs: opts.all ? 6500 : 2500,
			fetchGit: true,
			includeRegistry: true
		}));
		const agentStatusPromise = deferResult(getAgentLocalStatuses$1(cfg));
		const summaryPromise = deferResult(getStatusSummary({
			config: cfg,
			sourceConfig: loadedRaw
		}));
		progress.tick();
		progress.setLabel("Checking Tailscale…");
		const tailscaleDns = await tailscaleDnsPromise;
		const tailscaleHttpsUrl = tailscaleMode !== "off" && tailscaleDns ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}` : null;
		progress.tick();
		progress.setLabel("Checking for updates…");
		const update = unwrapDeferredResult(await updatePromise);
		progress.tick();
		progress.setLabel("Resolving agents…");
		const agentStatus = unwrapDeferredResult(await agentStatusPromise);
		progress.tick();
		progress.setLabel("Probing gateway…");
		const { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbeAuth, gatewayProbeAuthWarning, gatewayProbe } = await resolveGatewayProbeSnapshot({
			cfg,
			opts
		});
		const gatewayReachable = gatewayProbe?.ok === true;
		const gatewaySelf = gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null;
		progress.tick();
		progress.setLabel("Querying channel status…");
		const channelsStatus = await resolveChannelsStatus({
			cfg,
			gatewayReachable,
			opts
		});
		const { collectChannelStatusIssues, buildChannelsTable } = await loadStatusScanRuntimeModule();
		const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
		progress.tick();
		progress.setLabel("Summarizing channels…");
		const channels = await buildChannelsTable(cfg, {
			showSecrets: process.env.CLAWDBOT_SHOW_SECRETS?.trim() !== "0",
			sourceConfig: loadedRaw
		});
		progress.tick();
		progress.setLabel("Checking memory…");
		const memoryPlugin = resolveMemoryPluginStatus(cfg);
		const memory = await resolveMemoryStatusSnapshot({
			cfg,
			agentStatus,
			memoryPlugin
		});
		progress.tick();
		progress.setLabel("Reading sessions…");
		const summary = unwrapDeferredResult(await summaryPromise);
		progress.tick();
		progress.setLabel("Rendering…");
		progress.tick();
		return {
			cfg,
			sourceConfig: loadedRaw,
			secretDiagnostics,
			osSummary,
			tailscaleMode,
			tailscaleDns,
			tailscaleHttpsUrl,
			update,
			gatewayConnection,
			remoteUrlMissing,
			gatewayMode,
			gatewayProbeAuth,
			gatewayProbeAuthWarning,
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
let providerUsagePromise;
let securityAuditModulePromise;
function loadProviderUsage() {
	providerUsagePromise ??= import("./provider-usage-CiuZAmm0.js");
	return providerUsagePromise;
}
function loadSecurityAuditModule() {
	securityAuditModulePromise ??= import("./audit.runtime-B7RNcJIW.js");
	return securityAuditModulePromise;
}
function resolvePairingRecoveryContext(params) {
	const sanitizeRequestId = (value) => {
		const trimmed = value.trim();
		if (!trimmed) {return null;}
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {return null;}
		return trimmed;
	};
	const source = [params.error, params.closeReason].filter((part) => typeof part === "string" && part.trim().length > 0).join(" ");
	if (!source || !/pairing required/i.test(source)) {return null;}
	const requestIdMatch = source.match(/requestId:\s*([^\s)]+)/i);
	return { requestId: (requestIdMatch && requestIdMatch[1] ? sanitizeRequestId(requestIdMatch[1]) : null) || null };
}
async function statusCommand(opts, runtime) {
	if (opts.all && !opts.json) {
		await statusAllCommand(runtime, { timeoutMs: opts.timeoutMs });
		return;
	}
	const scan = await scanStatus({
		json: opts.json,
		timeoutMs: opts.timeoutMs,
		all: opts.all
	}, runtime);
	const runSecurityAudit = async () => await loadSecurityAuditModule().then(({ runSecurityAudit }) => runSecurityAudit({
		config: scan.cfg,
		sourceConfig: scan.sourceConfig,
		deep: false,
		includeFilesystem: true,
		includeChannelSecurity: true
	}));
	const securityAudit = opts.json ? await runSecurityAudit() : await withProgress({
		label: "Running security audit…",
		indeterminate: true,
		enabled: true
	}, async () => await runSecurityAudit());
	const { cfg, osSummary, tailscaleMode, tailscaleDns, tailscaleHttpsUrl, update, gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbeAuth, gatewayProbeAuthWarning, gatewayProbe, gatewayReachable, gatewaySelf, channelIssues, agentStatus, channels, summary, secretDiagnostics, memory, memoryPlugin } = scan;
	const usage = opts.usage ? await withProgress({
		label: "Fetching usage snapshot…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => {
		const { loadProviderUsageSummary } = await loadProviderUsage();
		return await loadProviderUsageSummary({ timeoutMs: opts.timeoutMs });
	}) : void 0;
	const health = opts.deep ? await withProgress({
		label: "Checking gateway health…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "health",
		params: { probe: true },
		timeoutMs: opts.timeoutMs,
		config: scan.cfg
	})) : void 0;
	const lastHeartbeat = opts.deep && gatewayReachable ? await callGateway({
		method: "last-heartbeat",
		params: {},
		timeoutMs: opts.timeoutMs,
		config: scan.cfg
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
				error: gatewayProbe?.error ?? null,
				authWarning: gatewayProbeAuthWarning ?? null
			},
			gatewayService: daemon,
			nodeService: nodeDaemon,
			agents: agentStatus,
			securityAudit,
			secretDiagnostics,
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
		const details = buildGatewayConnectionDetails({ config: scan.cfg });
		runtime.log(info("Gateway connection:"));
		for (const line of details.message.split("\n")) {runtime.log(`  ${line}`);}
		runtime.log("");
	}
	const tableWidth = getTerminalTableWidth();
	if (secretDiagnostics.length > 0) {
		runtime.log(theme.warn("Secret diagnostics:"));
		for (const entry of secretDiagnostics) {runtime.log(`- ${entry}`);}
		runtime.log("");
	}
	const dashboard = (() => {
		if (!(cfg.gateway?.controlUi?.enabled ?? true)) {return "disabled";}
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
		const auth = gatewayReachable && !remoteUrlMissing ? ` · auth ${formatGatewayAuthUsed(gatewayProbeAuth)}` : "";
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
		if (daemon.installed === false) {return `${daemon.label} not installed`;}
		const installedPrefix = daemon.managedByOpenClaw ? "installed · " : "";
		return `${daemon.label} ${installedPrefix}${daemon.loadedText}${daemon.runtimeShort ? ` · ${daemon.runtimeShort}` : ""}`;
	})();
	const nodeDaemonValue = (() => {
		if (nodeDaemon.installed === false) {return `${nodeDaemon.label} not installed`;}
		const installedPrefix = nodeDaemon.managedByOpenClaw ? "installed · " : "";
		return `${nodeDaemon.label} ${installedPrefix}${nodeDaemon.loadedText}${nodeDaemon.runtimeShort ? ` · ${nodeDaemon.runtimeShort}` : ""}`;
	})();
	const defaults = summary.sessions.defaults;
	const defaultCtx = defaults.contextTokens ? ` (${formatKTokens(defaults.contextTokens)} ctx)` : "";
	const eventsValue = summary.queuedSystemEvents.length > 0 ? `${summary.queuedSystemEvents.length} queued` : "none";
	const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");
	const heartbeatValue = (() => {
		const parts = summary.heartbeat.agents.map((agent) => {
			if (!agent.enabled || !agent.everyMs) {return `disabled (${agent.agentId})`;}
			return `${agent.every} (${agent.agentId})`;
		}).filter(Boolean);
		return parts.length > 0 ? parts.join(", ") : "disabled";
	})();
	const lastHeartbeatValue = (() => {
		if (!opts.deep) {return null;}
		if (!gatewayReachable) {return warn("unavailable");}
		if (!lastHeartbeat) {return muted("none");}
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
		if (!memoryPlugin.enabled) {return muted(`disabled${memoryPlugin.reason ? ` (${memoryPlugin.reason})` : ""}`);}
		if (!memory) {
			const slot = memoryPlugin.slot ? `plugin ${memoryPlugin.slot}` : "plugin";
			if (memoryPlugin.slot && memoryPlugin.slot !== "memory-core") {return `enabled (${slot})`;}
			return muted(`enabled (${slot}) · unavailable`);
		}
		const parts = [];
		const dirtySuffix = memory.dirty ? ` · ${warn("dirty")}` : "";
		parts.push(`${memory.files} files · ${memory.chunks} chunks${dirtySuffix}`);
		if (memory.sources?.length) {parts.push(`sources ${memory.sources.join(", ")}`);}
		if (memoryPlugin.slot) {parts.push(`plugin ${memoryPlugin.slot}`);}
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
		...gatewayProbeAuthWarning ? [{
			Item: "Gateway auth warning",
			Value: warn(gatewayProbeAuthWarning)
		}] : [],
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
		if (pairingRecovery.requestId) {runtime.log(theme.muted(`Recovery: ${formatCliCommand(`openclaw devices approve ${pairingRecovery.requestId}`)}`));}
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
	if (importantFindings.length === 0) {runtime.log(theme.muted("No critical or warn findings detected."));}
	else {
		const severityLabel = (sev) => {
			if (sev === "critical") {return theme.error("CRITICAL");}
			if (sev === "warn") {return theme.warn("WARN");}
			return theme.muted("INFO");
		};
		const sevRank = (sev) => sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
		const sorted = [...importantFindings].toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity));
		const shown = sorted.slice(0, 6);
		for (const f of shown) {
			runtime.log(`  ${severityLabel(f.severity)} ${f.title}`);
			runtime.log(`    ${shortenText(f.detail.replaceAll("\n", " "), 160)}`);
			if (f.remediation?.trim()) {runtime.log(`    ${theme.muted(`Fix: ${f.remediation.trim()}`)}`);}
		}
		if (sorted.length > shown.length) {runtime.log(theme.muted(`… +${sorted.length - shown.length} more`));}
	}
	runtime.log(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
	runtime.log(theme.muted(`Deep probe: ${formatCliCommand("openclaw security audit --deep")}`));
	runtime.log("");
	runtime.log(theme.heading("Channels"));
	const channelIssuesByChannel = groupChannelIssuesByChannel(channelIssues);
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
		if (summary.queuedSystemEvents.length > 5) {runtime.log(muted(`… +${summary.queuedSystemEvents.length - 5} more`));}
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
			if (colon === -1) {continue;}
			const item = line.slice(0, colon).trim();
			const detail = line.slice(colon + 1).trim();
			const normalized = detail.toLowerCase();
			const status = (() => {
				if (normalized.startsWith("ok")) {return ok("OK");}
				if (normalized.startsWith("failed")) {return warn("WARN");}
				if (normalized.startsWith("not configured")) {return muted("OFF");}
				if (normalized.startsWith("configured")) {return ok("OK");}
				if (normalized.startsWith("linked")) {return ok("LINKED");}
				if (normalized.startsWith("not linked")) {return warn("UNLINKED");}
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
		const { formatUsageReportLines } = await loadProviderUsage();
		runtime.log("");
		runtime.log(theme.heading("Usage"));
		for (const line of formatUsageReportLines(usage)) {runtime.log(line);}
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
	if (gatewayReachable) {runtime.log(`  Need to test channels? ${formatCliCommand("openclaw status --deep")}`);}
	else {runtime.log(`  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`);}
}
//#endregion
export { statusCommand as t };
