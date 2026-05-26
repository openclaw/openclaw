import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { t as formatConfigIssueLine } from "./issue-format-c8ezaSew.js";
import { c as classifyPortListener, d as isExpectedGatewayListeners, l as formatPortDiagnostics, o as inspectPortUsage, u as isDualStackLoopbackGatewayListeners } from "./ports-C3z_VZTO.js";
import { a as resolveGatewaySupervisorLogPaths, i as resolveGatewayRestartLogPath, r as resolveGatewayLogPaths } from "./restart-logs-DA9VPiFu.js";
import "./config-B6Oplu5W.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-p6c0nawT.js";
import { l as summarizeRestartSentinel, o as readRestartSentinel } from "./restart-sentinel-BDtpdKoy.js";
import { r as classifyOAuthRefreshFailureReason } from "./oauth-refresh-failure-szcD_aib.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { t as canExecRequestNode } from "./exec-defaults-60zNtKRO.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-BCbpja7h.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DPLbsdcw.js";
import { l as formatPluginCompatibilityNotice, n as buildPluginCompatibilityNotices } from "./status-BvY0BMpM.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { n as resolveStatusAllConnectionDetails } from "./status.gateway-connection-CyT_TFa4.js";
import { f as redactSecrets } from "./format-qvQo2sAg.js";
import { d as buildStatusOverviewSurfaceFromOverview, i as resolveStatusGatewayHealthSafe, n as resolveStatusGatewayDiagnosticsSafe, s as resolveStatusServiceSummaries } from "./status-runtime-shared-CC7Iwhf3.js";
import { a as buildStatusChannelsSection, c as buildStatusOverviewSection, f as formatUpdateRestartActionLines, i as buildStatusChannelDetailsSections, m as buildStatusAllOverviewRows, n as appendStatusSectionHeading, p as formatUpdateRestartStatusValue, r as buildStatusAgentsSection, t as appendStatusReportSections } from "./text-report-DSavWMY0.js";
import { t as resolveNodeOnlyGatewayInfo } from "./status.node-mode-B1gXLmQt.js";
import { t as collectStatusScanOverview } from "./status.scan-overview-XRCiRhU1.js";
import fs from "node:fs/promises";
//#region src/commands/status-all/report-data.ts
function resolveStatusAllConfigPath(path) {
	const trimmed = path?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : "(unknown config path)";
}
async function resolveStatusAllLocalDiagnosis(params) {
	const { overview } = params;
	const snap = await readConfigFileSnapshot().catch(() => null);
	const configPath = resolveStatusAllConfigPath(snap?.path);
	const health = params.nodeOnlyGateway ? void 0 : await resolveStatusGatewayHealthSafe({
		config: overview.cfg,
		timeoutMs: Math.min(8e3, params.timeoutMs ?? 1e4),
		gatewayReachable: params.gatewayReachable,
		gatewayProbeError: params.gatewayProbe?.error ?? null,
		...params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}
	});
	const diagnostics = params.nodeOnlyGateway ? null : await resolveStatusGatewayDiagnosticsSafe({
		config: overview.cfg,
		timeoutMs: Math.min(5e3, params.timeoutMs ?? 1e4),
		gatewayReachable: params.gatewayReachable,
		...params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}
	});
	params.progress.setLabel("Checking local state…");
	const sentinel = await readRestartSentinel().catch(() => null);
	const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
	const port = resolveGatewayPort(overview.cfg);
	const portUsage = await inspectPortUsage(port).catch(() => null);
	params.progress.tick();
	const defaultWorkspace = overview.agentStatus.agents.find((a) => a.id === overview.agentStatus.defaultId)?.workspaceDir ?? overview.agentStatus.agents[0]?.workspaceDir ?? null;
	const skillStatus = defaultWorkspace != null ? (() => {
		try {
			return buildWorkspaceSkillStatus(defaultWorkspace, {
				config: overview.cfg,
				eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
					cfg: overview.cfg,
					agentId: overview.agentStatus.defaultId
				}) }) }
			});
		} catch {
			return null;
		}
	})() : null;
	const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });
	return {
		configPath,
		health,
		diagnosis: {
			snap,
			remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
			secretDiagnostics: overview.secretDiagnostics,
			sentinel,
			lastErr,
			port,
			portUsage,
			tailscaleMode: overview.tailscaleMode,
			tailscale: {
				backendState: null,
				dnsName: overview.tailscaleDns,
				ips: [],
				error: null
			},
			tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
			skillStatus,
			pluginCompatibility,
			channelsStatus: overview.channelsStatus,
			channelIssues: overview.channelIssues,
			agentStatus: overview.agentStatus,
			gatewayReachable: params.gatewayReachable,
			health,
			deliveryDiagnostics: diagnostics,
			nodeOnlyGateway: params.nodeOnlyGateway
		}
	};
}
async function buildStatusAllReportData(params) {
	const gatewaySnapshot = params.overview.gatewaySnapshot;
	const { configPath, health, diagnosis } = await resolveStatusAllLocalDiagnosis({
		overview: params.overview,
		progress: params.progress,
		gatewayReachable: gatewaySnapshot.gatewayReachable,
		gatewayProbe: gatewaySnapshot.gatewayProbe,
		gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
		nodeOnlyGateway: params.nodeOnlyGateway,
		timeoutMs: params.timeoutMs
	});
	return {
		overviewRows: buildStatusAllOverviewRows({
			surface: buildStatusOverviewSurfaceFromOverview({
				overview: params.overview,
				gatewayService: params.daemon,
				nodeService: params.nodeService,
				nodeOnlyGateway: params.nodeOnlyGateway
			}),
			osLabel: params.overview.osSummary.label,
			configPath,
			secretDiagnosticsCount: params.overview.secretDiagnostics.length,
			updateRestartValue: formatUpdateRestartStatusValue(diagnosis.sentinel?.payload),
			agentStatus: params.overview.agentStatus,
			tailscaleBackendState: diagnosis.tailscale.backendState
		}),
		channels: params.overview.channels,
		channelIssues: params.overview.channelIssues.map((issue) => ({
			channel: issue.channel,
			message: issue.message
		})),
		agentStatus: params.overview.agentStatus,
		connectionDetailsForReport: resolveStatusAllConnectionDetails({
			nodeOnlyGateway: params.nodeOnlyGateway,
			remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
			gatewayConnection: gatewaySnapshot.gatewayConnection,
			bindMode: params.overview.cfg.gateway?.bind ?? "loopback",
			configPath
		}),
		diagnosis: {
			...diagnosis,
			health
		}
	};
}
//#endregion
//#region src/commands/status-all/gateway.ts
async function readFileTailLines(filePath, maxLines) {
	const raw = await fs.readFile(filePath, "utf8").catch(() => "");
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
				const code = normalizeOptionalString(parsed?.error?.code) ?? null;
				const msg = normalizeOptionalString(parsed?.error?.message) ?? null;
				const refreshReason = classifyOAuthRefreshFailureReason(msg ?? "");
				const msgShort = msg ? refreshReason ? "re-auth required" : shorten(msg, 52) : null;
				const base = `[${tag}] token refresh ${status}${code ? ` ${code}` : ""}${msgShort ? ` · ${msgShort}` : ""}`;
				addGroup(`token:${tag}:${status}:${code ?? ""}:${msgShort ?? ""}`, base);
				continue;
			}
		}
		const embedded = line.match(/^Embedded agent failed before reply:\s+OAuth token refresh failed for ([^:]+):/);
		if (embedded) {
			const provider = normalizeOptionalString(embedded[1]) || "unknown";
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
const AGENT_ACTIVITY_SOFT_WARNING_MS = 30 * 6e4;
function countRecentAgentSessions(agentStatus, thresholdMs) {
	return agentStatus.agents.filter((agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= thresholdMs).length;
}
function countGatewayListenerPids(portUsage) {
	const pids = /* @__PURE__ */ new Set();
	for (const listener of portUsage.listeners) {
		if (classifyPortListener(listener, portUsage.port) !== "gateway") continue;
		if (typeof listener.pid === "number" && Number.isFinite(listener.pid)) pids.add(listener.pid);
	}
	return pids.size;
}
function isDeliveryDiagnosticsLike(value) {
	return Boolean(value && typeof value === "object");
}
function countDeliveryEvent(snapshot, type) {
	const value = snapshot.summary?.byType?.[type];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function latestDeliveryEventAgeMs(snapshot) {
	const latestTs = (snapshot.events ?? []).filter((event) => [
		"message.received",
		"message.dispatch.started",
		"message.dispatch.completed",
		"session.turn.created",
		"message.processed"
	].includes(event.type ?? "")).reduce((max, event) => {
		const ts = event.ts;
		return typeof ts === "number" && Number.isFinite(ts) ? Math.max(max, ts) : max;
	}, 0);
	return latestTs > 0 ? Date.now() - latestTs : null;
}
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
		for (const issue of uniqueIssues.slice(0, 12)) lines.push(`  ${formatConfigIssueLine(issue, "-")}`);
		if (uniqueIssues.length > 12) lines.push(`  ${muted(`… +${uniqueIssues.length - 12} more`)}`);
	} else emitCheck("Config: read failed", "warn");
	if (params.remoteUrlMissing) {
		lines.push("");
		emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
		lines.push(`  ${muted("Fix: set gateway.remote.url, or set gateway.mode=local.")}`);
	}
	emitCheck(`Secret diagnostics (${params.secretDiagnostics.length})`, params.secretDiagnostics.length === 0 ? "ok" : "warn");
	for (const diagnostic of params.secretDiagnostics.slice(0, 10)) lines.push(`  - ${muted(redactSecrets(diagnostic))}`);
	if (params.secretDiagnostics.length > 10) lines.push(`  ${muted(`… +${params.secretDiagnostics.length - 10} more`)}`);
	if (params.sentinel?.payload) {
		emitCheck("Restart sentinel present", "warn");
		lines.push(`  ${muted(`${summarizeRestartSentinel(params.sentinel.payload)} · ${formatTimeAgo(Date.now() - params.sentinel.payload.ts)}`)}`);
		const updateRestartValue = formatUpdateRestartStatusValue(params.sentinel.payload, { formatTimeAgo });
		if (updateRestartValue) lines.push(`  ${muted(`Update restart: ${updateRestartValue}`)}`);
		for (const line of formatUpdateRestartActionLines(params.sentinel.payload)) lines.push(`  ${muted(line)}`);
	} else emitCheck("Restart sentinel: none", "ok");
	const lastErrClean = normalizeOptionalString(params.lastErr) ?? "";
	const isTrivialLastErr = lastErrClean.length < 8 || lastErrClean === "}" || lastErrClean === "{";
	if (lastErrClean && !isTrivialLastErr) {
		lines.push("");
		lines.push(muted("Gateway last log line:"));
		lines.push(`  ${muted(redactSecrets(lastErrClean))}`);
	}
	if (params.portUsage) {
		const benignDualStackLoopback = isDualStackLoopbackGatewayListeners(params.portUsage.listeners, params.port);
		const expectedGatewayListeners = isExpectedGatewayListeners(params.portUsage.listeners, params.port);
		const portOk = params.portUsage.listeners.length === 0 || expectedGatewayListeners;
		emitCheck(`Port ${params.port}`, portOk ? "ok" : "warn");
		if (!portOk) {
			const gatewayPidCount = countGatewayListenerPids(params.portUsage);
			if (gatewayPidCount > 1) lines.push(`  ${muted(`${gatewayPidCount} OpenClaw gateway processes appear to be listening on port ${params.port}; stop stale gateway processes before trusting channel health.`)}`);
			for (const line of formatPortDiagnostics(params.portUsage)) lines.push(`  ${muted(line)}`);
		} else if (benignDualStackLoopback) lines.push(`  ${muted("Detected dual-stack loopback listeners (127.0.0.1 + ::1) for one gateway process.")}`);
		else if (expectedGatewayListeners) lines.push(`  ${muted("Detected OpenClaw Gateway listener on the configured port.")}`);
	}
	{
		const backend = params.tailscale.backendState ?? "unknown";
		const okBackend = backend === "Running";
		const hasDns = Boolean(params.tailscale.dnsName);
		emitCheck(params.tailscaleMode === "off" ? `Tailscale exposure: off · daemon ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}` : `Tailscale exposure: ${params.tailscaleMode} · daemon ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}`, okBackend && (params.tailscaleMode === "off" || hasDns) ? "ok" : "warn");
		if (params.tailscale.error) lines.push(`  ${muted(`error: ${params.tailscale.error}`)}`);
		if (params.tailscale.ips.length > 0) lines.push(`  ${muted(`ips: ${params.tailscale.ips.slice(0, 3).join(", ")}${params.tailscale.ips.length > 3 ? "…" : ""}`)}`);
		if (params.tailscaleHttpsUrl) lines.push(`  ${muted(`https: ${params.tailscaleHttpsUrl}`)}`);
	}
	if (params.skillStatus) {
		const eligible = params.skillStatus.skills.filter((s) => s.eligible).length;
		const missing = params.skillStatus.skills.filter((s) => s.eligible && Object.values(s.missing).some((arr) => arr.length)).length;
		emitCheck(`Skills: ${eligible} eligible · ${missing} missing · ${params.skillStatus.workspaceDir}`, missing === 0 ? "ok" : "warn");
	}
	emitCheck(`Plugin compatibility (${params.pluginCompatibility.length || "none"})`, params.pluginCompatibility.length === 0 ? "ok" : "warn");
	for (const notice of params.pluginCompatibility.slice(0, 12)) {
		const severity = notice.severity === "warn" ? "warn" : "info";
		lines.push(`  - [${severity}] ${formatPluginCompatibilityNotice(notice)}`);
	}
	if (params.pluginCompatibility.length > 12) lines.push(`  ${muted(`… +${params.pluginCompatibility.length - 12} more`)}`);
	if (params.agentStatus) {
		const recentSessions = countRecentAgentSessions(params.agentStatus, AGENT_ACTIVITY_SOFT_WARNING_MS);
		const shouldWarn = params.agentStatus.totalSessions > 0 && recentSessions === 0;
		emitCheck(`Agent activity: ${recentSessions} active in 30m · ${params.agentStatus.totalSessions} sessions`, shouldWarn ? "warn" : "ok");
		if (shouldWarn) lines.push(`  ${muted("No agent session was updated in the last 30m; if channels received messages, verify inbound dispatch and turn creation.")}`);
	}
	if (params.deliveryDiagnostics != null) if (isDeliveryDiagnosticsLike(params.deliveryDiagnostics)) {
		const received = countDeliveryEvent(params.deliveryDiagnostics, "message.received");
		const dispatchStarted = countDeliveryEvent(params.deliveryDiagnostics, "message.dispatch.started");
		const dispatchCompleted = countDeliveryEvent(params.deliveryDiagnostics, "message.dispatch.completed");
		const turnsCreated = countDeliveryEvent(params.deliveryDiagnostics, "session.turn.created");
		const processed = countDeliveryEvent(params.deliveryDiagnostics, "message.processed");
		const hasReceivedWithoutDispatch = received > 0 && dispatchStarted === 0 && processed === 0;
		const hasDispatchWithoutTurn = dispatchStarted > 0 && turnsCreated === 0 && processed < dispatchStarted;
		const hasDispatchGap = dispatchStarted - dispatchCompleted >= 2;
		const latestAgeMs = latestDeliveryEventAgeMs(params.deliveryDiagnostics);
		emitCheck(`Inbound delivery telemetry: received ${received} · dispatch ${dispatchStarted}/${dispatchCompleted} · turns ${turnsCreated} · processed ${processed}`, hasReceivedWithoutDispatch || hasDispatchWithoutTurn || hasDispatchGap ? "warn" : "ok");
		if (latestAgeMs != null) lines.push(`  ${muted(`latest delivery event: ${formatTimeAgo(latestAgeMs)}`)}`);
		if (hasReceivedWithoutDispatch) lines.push(`  ${muted("Messages were received, but no gateway dispatch started; inspect inbound routing and dispatch handoff.")}`);
		if (hasDispatchWithoutTurn) lines.push(`  ${muted("Gateway dispatch started, but no agent turn was created; inspect reply resolver and session creation.")}`);
		if (hasDispatchGap) lines.push(`  ${muted("Multiple gateway dispatches have not completed yet; if this persists, inspect stuck sessions or model runs.")}`);
	} else emitCheck("Inbound delivery telemetry: unavailable", "warn");
	else if (params.gatewayReachable && !params.nodeOnlyGateway) emitCheck("Inbound delivery telemetry: unavailable", "warn");
	params.progress.setLabel("Reading logs…");
	const logPaths = (() => {
		try {
			return process.platform === "darwin" ? resolveGatewaySupervisorLogPaths(process.env, { platform: "darwin" }) : resolveGatewayLogPaths(process.env);
		} catch {
			return null;
		}
	})();
	if (logPaths) {
		params.progress.setLabel("Reading logs…");
		const restartLogPath = resolveGatewayRestartLogPath(process.env);
		const readStderr = process.platform !== "darwin";
		const [stderrTail, stdoutTail, restartTail] = await Promise.all([
			readStderr ? readFileTailLines(logPaths.stderrPath, 40).catch(() => []) : [],
			readFileTailLines(logPaths.stdoutPath, 40).catch(() => []),
			readFileTailLines(restartLogPath, 30).catch(() => [])
		]);
		if (stderrTail.length > 0 || stdoutTail.length > 0) {
			lines.push("");
			lines.push(muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`));
			if (readStderr) {
				lines.push(`  ${muted(`# stderr: ${logPaths.stderrPath}`)}`);
				for (const line of summarizeLogTail(stderrTail, { maxLines: 22 }).map(redactSecrets)) lines.push(`  ${muted(line)}`);
			}
			lines.push(`  ${muted(`# stdout: ${logPaths.stdoutPath}`)}`);
			for (const line of summarizeLogTail(stdoutTail, { maxLines: 22 }).map(redactSecrets)) lines.push(`  ${muted(line)}`);
		}
		if (restartTail.length > 0) {
			lines.push("");
			lines.push(muted(`Gateway restart attempts (tail): ${restartLogPath}`));
			for (const line of summarizeLogTail(restartTail, { maxLines: 16 }).map(redactSecrets)) lines.push(`  ${muted(line)}`);
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
	} else if (params.nodeOnlyGateway) emitCheck(`Channel issues skipped (node-only mode; query ${params.nodeOnlyGateway.gatewayTarget})`, "ok");
	else emitCheck(`Channel issues skipped (gateway ${params.gatewayReachable ? "query failed" : "unreachable"})`, "warn");
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
	const tableWidth = getTerminalTableWidth();
	const lines = [];
	lines.push(heading("OpenClaw status --all"));
	appendStatusReportSections({
		lines,
		heading,
		sections: [
			buildStatusOverviewSection({
				width: tableWidth,
				renderTable,
				rows: params.overviewRows
			}),
			buildStatusChannelsSection({
				width: tableWidth,
				renderTable,
				rows: params.channels.rows,
				channelIssues: params.channelIssues,
				ok,
				warn,
				muted,
				accentDim: theme.accentDim,
				formatIssueMessage: (message) => message.slice(0, 90)
			}),
			...buildStatusChannelDetailsSections({
				details: params.channels.details,
				width: tableWidth,
				renderTable,
				ok,
				warn
			}),
			buildStatusAgentsSection({
				width: tableWidth,
				renderTable,
				agentStatus: params.agentStatus,
				ok,
				warn
			})
		]
	});
	appendStatusSectionHeading({
		lines,
		heading,
		title: "Diagnosis (read-only)"
	});
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
		const overview = await collectStatusScanOverview({
			commandName: "status --all",
			opts: { timeoutMs: opts?.timeoutMs },
			showSecrets: false,
			runtime,
			useGatewayCallOverridesForChannelsStatus: true,
			progress,
			labels: {
				loadingConfig: "Loading config…",
				checkingTailscale: "Checking Tailscale…",
				checkingForUpdates: "Checking for updates…",
				resolvingAgents: "Scanning agents…",
				probingGateway: "Probing gateway…",
				queryingChannelStatus: "Querying gateway…",
				summarizingChannels: "Summarizing channels…"
			}
		});
		progress.setLabel("Checking services…");
		const [daemon, nodeService] = await resolveStatusServiceSummaries();
		const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
			daemon,
			node: nodeService
		});
		progress.tick();
		const lines = await buildStatusAllReportLines({
			progress,
			...await buildStatusAllReportData({
				overview,
				daemon,
				nodeService,
				nodeOnlyGateway,
				progress,
				timeoutMs: opts?.timeoutMs
			})
		});
		progress.setLabel("Rendering…");
		runtime.log(lines.join("\n"));
		progress.tick();
	});
}
//#endregion
export { statusAllCommand };
