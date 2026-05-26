import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { n as isRich, r as theme } from "./theme-CStEj1vt.js";
import { T as pathExists } from "./fs-safe-DpJlqO1z.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-DFEyR49L.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { C as setVerbose } from "./logger-DIiFDaHc.js";
import { n as info$1 } from "./globals-CouSpJO4.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { t as sanitizeTerminalText } from "./safe-text-CdNixupx.js";
import "./config-CzeRK-GW.js";
import { i as formatLookupMiss } from "./error-format-ByBZDdph.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import "./message-channel-s-A-ruKR.js";
import { i as callGateway, l as isGatewayTransportError } from "./call-DO7ujqcl.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, r as resolveDefaultSessionStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore, y as pruneStaleEntries } from "./store-load-cmAGD4uk.js";
import { s as updateSessionStore } from "./store-3qAZ3Zl6.js";
import { r as resolveAllAgentSessionStoreTargetsSync } from "./targets-DaLztPKR.js";
import { i as serializeSessionCleanupResult, n as resolveSessionCleanupAction, r as runSessionsCleanup } from "./sessions-BhOk6siH.js";
import { E as updateTaskNotifyPolicyById, F as listTaskFlowRecords, N as getTaskFlowById, R as resolveTaskFlowForLookupToken, V as updateFlowRecordByIdExpectedRevision, k as deleteTaskFlowRecordById, p as listTasksForFlowId, s as getTaskById } from "./task-registry-DFUW-xBJ.js";
import { n as summarizeTaskRecords } from "./task-registry.summary-C_bUa0ta.js";
import "./runtime-internal-Bqu0JS7i.js";
import { l as getFlowTaskSummary, n as cancelFlowById, t as cancelDetachedTaskRunById } from "./task-executor-CXkSlQGM.js";
import { n as loadCronStoreSync, r as resolveCronStorePath } from "./store-CghHeK-D.js";
import { t as compareTaskAuditFindingSortKeys } from "./task-registry.audit.shared-DBmoktSk.js";
import { n as listTaskAuditFindings, r as summarizeTaskAuditFindings } from "./task-registry.audit-CSa06qoF.js";
import { c as reconcileTaskLookupToken, d as runTaskRegistryMaintenance, i as getInspectableTaskRegistrySummary, o as previewTaskRegistryMaintenance, r as getInspectableTaskAuditSummary, s as reconcileInspectableTasks, t as configureTaskRegistryMaintenance } from "./task-registry.maintenance-gbHgqdM1.js";
import { c as resolveCommitmentStorePath, s as markCommitmentsStatus, t as listCommitments } from "./store-t9Y6uavK.js";
import { n as runCommandWithRuntime } from "./cli-utils-C7ZilvgD.js";
import { t as formatHelpExamples } from "./help-format-C6bIKvbJ.js";
import { n as parsePositiveIntOrUndefined } from "./helpers-CSBw61zy.js";
import { n as formatTrajectoryCommandExportSummary, t as exportTrajectoryForCommand } from "./command-export-v2GSUX4P.js";
import { n as healthCommand } from "./health-IaeWgo39.js";
import { a as formatSessionModelCell, c as resolveSessionStoreTargetsOrExit, i as formatSessionKeyCell, n as formatSessionAgeCell, o as toSessionDisplayRows, r as formatSessionFlagsCell, s as resolveSessionDisplayModel, t as sessionsCommand } from "./sessions-B5dzJVcm.js";
import { n as statusCommand } from "./status.command-DdukqIzh.js";
import "./status-D8dESP54.js";
import { n as summarizeTaskFlowAuditFindings, t as listTaskFlowAuditFindings } from "./task-flow-registry.audit-D1g1aVx8.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/commitments.ts
const STATUS_VALUES = new Set([
	"pending",
	"sent",
	"dismissed",
	"snoozed",
	"expired"
]);
function truncate$2(value, maxChars) {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}...`;
}
function safe(value) {
	return sanitizeTerminalText(value);
}
function parseStatus(raw, runtime) {
	const status = normalizeOptionalString(raw);
	if (!status) return;
	if (STATUS_VALUES.has(status)) return status;
	runtime.error(`Unknown commitment status: ${status}. Use one of: ${Array.from(STATUS_VALUES).join(", ")}.`);
	runtime.exit(1);
}
function isActiveCommitment(commitment) {
	return commitment.status === "pending" || commitment.status === "snoozed";
}
function formatDue(ms) {
	return new Date(ms).toISOString();
}
function formatRows(commitments, rich) {
	const header = [
		"ID".padEnd(16),
		"Status".padEnd(10),
		"Kind".padEnd(16),
		"Due".padEnd(24),
		"Scope".padEnd(28),
		"Suggested text"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const commitment of commitments) {
		const scope = truncate$2([
			safe(commitment.agentId),
			safe(commitment.channel),
			safe(commitment.to ?? commitment.sessionKey)
		].filter(Boolean).join("/"), 28);
		lines.push([
			truncate$2(safe(commitment.id), 16).padEnd(16),
			safe(commitment.status).padEnd(10),
			safe(commitment.kind).padEnd(16),
			formatDue(commitment.dueWindow.earliestMs).padEnd(24),
			scope.padEnd(28),
			truncate$2(safe(commitment.suggestedText), 90)
		].join(" "));
	}
	return lines;
}
async function commitmentsListCommand(opts, runtime) {
	const cfg = getRuntimeConfig();
	const status = opts.all ? void 0 : parseStatus(opts.status ?? "pending", runtime);
	if (!opts.all && opts.status && !status) return;
	const commitments = (await listCommitments({
		cfg,
		status,
		agentId: normalizeOptionalString(opts.agent)
	})).filter((commitment) => opts.all || status || isActiveCommitment(commitment));
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: commitments.length,
			status: status ?? (opts.all ? null : "pending"),
			agentId: normalizeOptionalString(opts.agent) ?? null,
			store: resolveCommitmentStorePath(),
			commitments
		}, null, 2));
		return;
	}
	runtime.log(info$1(`Commitments: ${commitments.length}`));
	runtime.log(info$1(`Store: ${resolveCommitmentStorePath()}`));
	if (status) runtime.log(info$1(`Status filter: ${status}`));
	if (opts.agent) runtime.log(info$1(`Agent filter: ${opts.agent}`));
	if (commitments.length === 0) {
		runtime.log(`No commitments found. Run ${formatCliCommand("openclaw commitments --all")} to include dismissed and expired commitments.`);
		return;
	}
	for (const line of formatRows(commitments, isRich())) runtime.log(line);
}
async function commitmentsDismissCommand(opts, runtime) {
	const ids = opts.ids.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) {
		runtime.error(`At least one commitment id is required. Run ${formatCliCommand("openclaw commitments list")} to choose one.`);
		runtime.exit(1);
		return;
	}
	await markCommitmentsStatus({
		cfg: getRuntimeConfig(),
		ids,
		status: "dismissed",
		nowMs: Date.now()
	});
	if (opts.json) {
		runtime.log(JSON.stringify({ dismissed: ids }, null, 2));
		return;
	}
	runtime.log(info$1(`Dismissed commitments: ${ids.join(", ")}`));
}
//#endregion
//#region src/commands/export-trajectory.ts
const ENCODED_EXPORT_REQUEST_RE = /^[A-Za-z0-9_-]{1,65536}$/u;
function readOptionalString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function decodeExportTrajectoryRequest(encoded) {
	const trimmed = encoded.trim();
	if (!ENCODED_EXPORT_REQUEST_RE.test(trimmed)) throw new Error("Encoded trajectory export request is invalid");
	const decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Encoded trajectory export request must be a JSON object");
	const request = decoded;
	return {
		sessionKey: readOptionalString(request.sessionKey) ?? "",
		output: readOptionalString(request.output),
		store: readOptionalString(request.store),
		agent: readOptionalString(request.agent),
		workspace: readOptionalString(request.workspace)
	};
}
function resolveExportTrajectoryOptions(opts) {
	const encoded = opts.requestJsonBase64?.trim();
	if (!encoded) return opts;
	return {
		...opts,
		...decodeExportTrajectoryRequest(encoded)
	};
}
async function exportTrajectoryCommand(opts, runtime) {
	let resolvedOpts;
	try {
		resolvedOpts = resolveExportTrajectoryOptions(opts);
	} catch (error) {
		runtime.error(`Failed to decode trajectory export request: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	const sessionKey = resolvedOpts.sessionKey?.trim();
	if (!sessionKey) {
		runtime.error(`--session-key is required. Run ${formatCliCommand("openclaw sessions")} to choose a session.`);
		runtime.exit(1);
		return;
	}
	const targetAgentId = resolvedOpts.agent ?? resolveAgentIdFromSessionKey(sessionKey);
	const storePath = resolvedOpts.store ? path.resolve(resolvedOpts.store) : resolveDefaultSessionStorePath(targetAgentId);
	const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
	if (!entry?.sessionId) {
		runtime.error(`Session not found: ${sessionKey}. Run ${formatCliCommand("openclaw sessions")} to see available sessions.`);
		runtime.exit(1);
		return;
	}
	let sessionFile;
	try {
		sessionFile = resolveSessionFilePath(entry.sessionId, entry, resolveSessionFilePathOptions({
			agentId: targetAgentId,
			storePath
		}));
	} catch (error) {
		runtime.error(`Failed to resolve session file: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	if (!await pathExists(sessionFile)) {
		runtime.error(`Session file not found for ${sessionKey}. Run ${formatCliCommand("openclaw doctor")} to inspect session storage.`);
		runtime.exit(1);
		return;
	}
	let summary;
	try {
		summary = await exportTrajectoryForCommand({
			outputPath: resolvedOpts.output,
			sessionFile,
			sessionId: entry.sessionId,
			sessionKey,
			workspaceDir: path.resolve(resolvedOpts.workspace ?? process.cwd())
		});
	} catch (error) {
		runtime.error(`Failed to export trajectory: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	if (resolvedOpts.json) {
		writeRuntimeJson(runtime, summary);
		return;
	}
	runtime.log(formatTrajectoryCommandExportSummary(summary));
}
//#endregion
//#region src/commands/flows.ts
const ID_PAD$1 = 10;
const STATUS_PAD$1 = 10;
const MODE_PAD = 14;
const REV_PAD = 6;
const CTRL_PAD = 20;
function formatFlowLookupMiss(lookup) {
	return `TaskFlow not found: ${lookup}. Run ${formatCliCommand("openclaw tasks flow list")} to see recent flow ids.`;
}
function truncate$1(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 1)}…`;
}
function safeFlowDisplayText(value, maxChars) {
	const sanitized = sanitizeTerminalText(value ?? "").trim();
	if (!sanitized) return "n/a";
	return typeof maxChars === "number" ? truncate$1(sanitized, maxChars) : sanitized;
}
function shortToken$1(value, maxChars = ID_PAD$1) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "n/a";
	return truncate$1(trimmed, maxChars);
}
function formatFlowStatusCell(status, rich) {
	const padded = status.padEnd(STATUS_PAD$1);
	if (!rich) return padded;
	if (status === "succeeded") return theme.success(padded);
	if (status === "failed" || status === "lost") return theme.error(padded);
	if (status === "running") return theme.accentBright(padded);
	if (status === "blocked") return theme.warn(padded);
	return theme.muted(padded);
}
function formatFlowRows(flows, rich) {
	const header = [
		"TaskFlow".padEnd(ID_PAD$1),
		"Mode".padEnd(MODE_PAD),
		"Status".padEnd(STATUS_PAD$1),
		"Rev".padEnd(REV_PAD),
		"Controller".padEnd(CTRL_PAD),
		"Tasks".padEnd(14),
		"Goal"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const flow of flows) {
		const taskSummary = getFlowTaskSummary(flow.flowId);
		const counts = `${taskSummary.active} active/${taskSummary.total} total`;
		lines.push([
			shortToken$1(flow.flowId).padEnd(ID_PAD$1),
			flow.syncMode.padEnd(MODE_PAD),
			formatFlowStatusCell(flow.status, rich),
			String(flow.revision).padEnd(REV_PAD),
			safeFlowDisplayText(flow.controllerId, CTRL_PAD).padEnd(CTRL_PAD),
			counts.padEnd(14),
			safeFlowDisplayText(flow.goal, 80)
		].join(" "));
	}
	return lines;
}
function formatFlowListSummary(flows) {
	return `${flows.filter((flow) => flow.status === "queued" || flow.status === "running").length} active · ${flows.filter((flow) => flow.status === "blocked").length} blocked · ${flows.filter((flow) => flow.cancelRequestedAt != null).length} cancel-requested · ${flows.length} total`;
}
function summarizeWait(flow) {
	if (flow.waitJson == null) return "n/a";
	if (typeof flow.waitJson === "string" || typeof flow.waitJson === "number" || typeof flow.waitJson === "boolean") return String(flow.waitJson);
	if (Array.isArray(flow.waitJson)) return `array(${flow.waitJson.length})`;
	return Object.keys(flow.waitJson).toSorted().join(", ") || "object";
}
function summarizeFlowState(flow) {
	if (flow.status === "blocked") {
		if (flow.blockedSummary) return flow.blockedSummary;
		if (flow.blockedTaskId) return `blocked by ${flow.blockedTaskId}`;
		return "blocked";
	}
	if (flow.status === "waiting" && flow.waitJson != null) return summarizeWait(flow);
	return null;
}
async function flowsListCommand(opts, runtime) {
	const statusFilter = opts.status?.trim();
	const flows = listTaskFlowRecords().filter((flow) => {
		if (statusFilter && flow.status !== statusFilter) return false;
		return true;
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: flows.length,
			status: statusFilter ?? null,
			flows: flows.map((flow) => ({
				...flow,
				tasks: listTasksForFlowId(flow.flowId),
				taskSummary: getFlowTaskSummary(flow.flowId)
			}))
		}, null, 2));
		return;
	}
	runtime.log(info$1(`TaskFlows: ${flows.length}`));
	runtime.log(info$1(`TaskFlow pressure: ${formatFlowListSummary(flows)}`));
	if (statusFilter) runtime.log(info$1(`Status filter: ${statusFilter}`));
	if (flows.length === 0) {
		runtime.log(`No TaskFlows found. Run ${formatCliCommand("openclaw tasks list")} to inspect standalone background tasks.`);
		return;
	}
	const rich = isRich();
	for (const line of formatFlowRows(flows, rich)) runtime.log(line);
}
async function flowsShowCommand(opts, runtime) {
	const flow = resolveTaskFlowForLookupToken(opts.lookup);
	if (!flow) {
		runtime.error(formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const tasks = listTasksForFlowId(flow.flowId);
	const taskSummary = getFlowTaskSummary(flow.flowId);
	const stateSummary = summarizeFlowState(flow);
	if (opts.json) {
		runtime.log(JSON.stringify({
			...flow,
			tasks,
			taskSummary
		}, null, 2));
		return;
	}
	const lines = [
		"TaskFlow:",
		`flowId: ${flow.flowId}`,
		`status: ${flow.status}`,
		`goal: ${safeFlowDisplayText(flow.goal)}`,
		`currentStep: ${safeFlowDisplayText(flow.currentStep)}`,
		`owner: ${safeFlowDisplayText(flow.ownerKey)}`,
		`notify: ${flow.notifyPolicy}`,
		...stateSummary ? [`state: ${safeFlowDisplayText(stateSummary)}`] : [],
		...flow.cancelRequestedAt ? [`cancelRequestedAt: ${new Date(flow.cancelRequestedAt).toISOString()}`] : [],
		`createdAt: ${new Date(flow.createdAt).toISOString()}`,
		`updatedAt: ${new Date(flow.updatedAt).toISOString()}`,
		`endedAt: ${flow.endedAt ? new Date(flow.endedAt).toISOString() : "n/a"}`,
		`tasks: ${taskSummary.total} total · ${taskSummary.active} active · ${taskSummary.failures} issues`
	];
	for (const line of lines) runtime.log(line);
	if (tasks.length === 0) {
		runtime.log("Linked tasks: none");
		return;
	}
	runtime.log("Linked tasks:");
	for (const task of tasks) {
		const safeLabel = safeFlowDisplayText(task.label ?? task.task);
		runtime.log(`- ${task.taskId} ${task.status} ${task.runId ?? "n/a"} ${safeLabel}`);
	}
}
async function flowsCancelCommand(opts, runtime) {
	const flow = resolveTaskFlowForLookupToken(opts.lookup);
	if (!flow) {
		runtime.error(formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const result = await cancelFlowById({
		cfg: getRuntimeConfig(),
		flowId: flow.flowId
	});
	if (!result.found) {
		runtime.error(result.reason ?? formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (!result.cancelled) {
		runtime.error(result.reason ?? `Could not cancel TaskFlow: ${opts.lookup}`);
		runtime.exit(1);
		return;
	}
	const updated = getTaskFlowById(flow.flowId) ?? result.flow ?? flow;
	runtime.log(`Cancelled ${updated.flowId} (${updated.syncMode}) with status ${updated.status}.`);
}
//#endregion
//#region src/commands/sessions-cleanup.ts
const ACTION_PAD = 16;
function formatCleanupActionCell(action, rich) {
	const label = action.padEnd(ACTION_PAD);
	if (!rich) return label;
	if (action === "keep") return theme.muted(label);
	if (action === "prune-missing") return theme.error(label);
	if (action === "prune-stale") return theme.warn(label);
	if (action === "retire-dm-scope") return theme.warn(label);
	if (action === "cap-overflow") return theme.accentBright(label);
	return theme.error(label);
}
function buildActionRows(params) {
	return toSessionDisplayRows(params.beforeStore).map((row) => Object.assign({}, row, { action: resolveSessionCleanupAction({
		key: row.key,
		missingKeys: params.missingKeys,
		staleKeys: params.staleKeys,
		cappedKeys: params.cappedKeys,
		budgetEvictedKeys: params.budgetEvictedKeys,
		dmScopeRetiredKeys: params.dmScopeRetiredKeys
	}) }));
}
function renderStoreDryRunPlan(params) {
	const rich = isRich();
	if (params.showAgentHeader) params.runtime.log(`Agent: ${params.summary.agentId}`);
	params.runtime.log(`Session store: ${params.summary.storePath}`);
	params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
	params.runtime.log(`Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`);
	params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
	params.runtime.log(`Would retire stale direct DM sessions: ${params.summary.dmScopeRetired}`);
	params.runtime.log(`Would prune stale: ${params.summary.pruned}`);
	params.runtime.log(`Would cap overflow: ${params.summary.capped}`);
	if (params.summary.unreferencedArtifacts?.scannedFiles) params.runtime.log(`Would prune unreferenced artifacts: ${params.summary.unreferencedArtifacts.removedFiles}`);
	if (params.summary.diskBudget) params.runtime.log(`Would enforce disk budget: ${params.summary.diskBudget.totalBytesBefore} -> ${params.summary.diskBudget.totalBytesAfter} bytes (files ${params.summary.diskBudget.removedFiles}, entries ${params.summary.diskBudget.removedEntries})`);
	if (params.actionRows.length === 0) return;
	params.runtime.log("");
	params.runtime.log("Planned session actions:");
	const header = [
		"Action".padEnd(ACTION_PAD),
		"Key".padEnd(26),
		"Age".padEnd(9),
		"Model".padEnd(14),
		"Flags"
	].join(" ");
	params.runtime.log(rich ? theme.heading(header) : header);
	for (const actionRow of params.actionRows) {
		const model = resolveSessionDisplayModel(params.cfg, actionRow);
		const line = [
			formatCleanupActionCell(actionRow.action, rich),
			formatSessionKeyCell(actionRow.key, rich),
			formatSessionAgeCell(actionRow.updatedAt, rich),
			formatSessionModelCell(model, rich),
			formatSessionFlagsCell(actionRow, rich)
		].join(" ");
		params.runtime.log(line.trimEnd());
	}
}
function renderAppliedSummaries(params) {
	for (let i = 0; i < params.summaries.length; i += 1) {
		const summary = params.summaries[i];
		if (!summary) continue;
		if (i > 0) params.runtime.log("");
		if (params.summaries.length > 1) params.runtime.log(`Agent: ${summary.agentId}`);
		params.runtime.log(`Session store: ${summary.storePath}`);
		params.runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
		if (summary.unreferencedArtifacts?.removedFiles) params.runtime.log(`Pruned unreferenced artifacts: ${summary.unreferencedArtifacts.removedFiles}`);
	}
}
async function maybeRunGatewayCleanup(opts) {
	if (opts.store || opts.dryRun) return null;
	try {
		return await callGateway({
			method: "sessions.cleanup",
			params: {
				agent: opts.agent,
				allAgents: opts.allAgents,
				enforce: opts.enforce,
				activeKey: opts.activeKey,
				fixMissing: opts.fixMissing,
				fixDmScope: opts.fixDmScope
			},
			mode: GATEWAY_CLIENT_MODES.CLI,
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			requiredMethods: ["sessions.cleanup"]
		});
	} catch (error) {
		if (isGatewayTransportError(error)) return null;
		throw error;
	}
}
async function sessionsCleanupCommand(opts, runtime) {
	const gatewayResult = await maybeRunGatewayCleanup(opts);
	if (gatewayResult) {
		if (opts.json) {
			writeRuntimeJson(runtime, gatewayResult);
			return;
		}
		renderAppliedSummaries({
			summaries: "stores" in gatewayResult ? gatewayResult.stores : [gatewayResult],
			runtime
		});
		return;
	}
	const cfg = getRuntimeConfig();
	const targets = resolveSessionStoreTargetsOrExit({
		cfg,
		opts: {
			store: opts.store,
			agent: opts.agent,
			allAgents: opts.allAgents
		},
		runtime
	});
	if (!targets) return;
	const { mode, previewResults, appliedSummaries } = await runSessionsCleanup({
		cfg,
		opts,
		targets
	});
	if (opts.dryRun) {
		if (opts.json) {
			writeRuntimeJson(runtime, serializeSessionCleanupResult({
				mode,
				dryRun: true,
				summaries: previewResults.map((result) => result.summary)
			}));
			return;
		}
		for (let i = 0; i < previewResults.length; i += 1) {
			const result = previewResults[i];
			if (i > 0) runtime.log("");
			renderStoreDryRunPlan({
				cfg,
				summary: result.summary,
				actionRows: buildActionRows(result),
				runtime,
				showAgentHeader: previewResults.length > 1
			});
		}
		return;
	}
	if (opts.json) {
		writeRuntimeJson(runtime, serializeSessionCleanupResult({
			mode,
			dryRun: false,
			summaries: appliedSummaries
		}));
		return;
	}
	renderAppliedSummaries({
		summaries: appliedSummaries,
		runtime
	});
}
//#endregion
//#region src/tasks/task-flow-registry.maintenance.ts
const TASK_FLOW_RETENTION_MS = 10080 * 6e4;
function isTerminalFlow(flow) {
	return flow.status === "succeeded" || flow.status === "blocked" || flow.status === "failed" || flow.status === "cancelled" || flow.status === "lost";
}
function hasActiveLinkedTasks(flowId) {
	return listTasksForFlowId(flowId).some((task) => task.status === "queued" || task.status === "running");
}
function resolveTerminalAt(flow) {
	return flow.endedAt ?? flow.updatedAt ?? flow.createdAt;
}
function shouldPruneFlow(flow, now) {
	if (!isTerminalFlow(flow)) return false;
	if (hasActiveLinkedTasks(flow.flowId)) return false;
	return now - resolveTerminalAt(flow) >= TASK_FLOW_RETENTION_MS;
}
function shouldFinalizeCancelledFlow(flow) {
	if (flow.syncMode !== "managed") return false;
	if (flow.cancelRequestedAt == null || isTerminalFlow(flow)) return false;
	return !hasActiveLinkedTasks(flow.flowId);
}
function finalizeCancelledFlow(flow, now) {
	let current = flow;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const endedAt = Math.max(now, current.updatedAt, current.cancelRequestedAt ?? now);
		const result = updateFlowRecordByIdExpectedRevision({
			flowId: current.flowId,
			expectedRevision: current.revision,
			patch: {
				status: "cancelled",
				blockedTaskId: null,
				blockedSummary: null,
				waitJson: null,
				endedAt,
				updatedAt: endedAt
			}
		});
		if (result.applied) return true;
		if (result.reason === "not_found" || !result.current) return false;
		current = result.current;
		if (!shouldFinalizeCancelledFlow(current)) return false;
	}
	return false;
}
function shouldRepairTerminalMirroredFlowTimestamp(flow) {
	if (flow.syncMode !== "task_mirrored" || !isTerminalFlow(flow)) return false;
	if (flow.endedAt == null || flow.endedAt < flow.createdAt) return false;
	return flow.updatedAt > flow.endedAt;
}
function repairTerminalMirroredFlowTimestamp(flow) {
	let current = flow;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!shouldRepairTerminalMirroredFlowTimestamp(current)) return false;
		const result = updateFlowRecordByIdExpectedRevision({
			flowId: current.flowId,
			expectedRevision: current.revision,
			patch: { updatedAt: current.endedAt }
		});
		if (result.applied) return true;
		if (result.reason === "not_found" || !result.current) return false;
		current = result.current;
	}
	return false;
}
function getInspectableTaskFlowAuditSummary() {
	return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}
function previewTaskFlowRegistryMaintenance() {
	const now = Date.now();
	let reconciled = 0;
	let pruned = 0;
	for (const flow of listTaskFlowRecords()) {
		if (shouldRepairTerminalMirroredFlowTimestamp(flow)) {
			reconciled += 1;
			continue;
		}
		if (shouldFinalizeCancelledFlow(flow)) {
			reconciled += 1;
			continue;
		}
		if (shouldPruneFlow(flow, now)) pruned += 1;
	}
	return {
		reconciled,
		pruned
	};
}
async function runTaskFlowRegistryMaintenance() {
	const now = Date.now();
	let reconciled = 0;
	let pruned = 0;
	for (const flow of listTaskFlowRecords()) {
		const current = getTaskFlowById(flow.flowId);
		if (!current) continue;
		if (shouldRepairTerminalMirroredFlowTimestamp(current)) {
			if (repairTerminalMirroredFlowTimestamp(current)) reconciled += 1;
			continue;
		}
		if (shouldFinalizeCancelledFlow(current)) {
			if (finalizeCancelledFlow(current, now)) reconciled += 1;
			continue;
		}
		if (shouldPruneFlow(current, now) && deleteTaskFlowRecordById(current.flowId)) pruned += 1;
	}
	return {
		reconciled,
		pruned
	};
}
//#endregion
//#region src/commands/tasks.ts
const RUNTIME_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;
const SESSION_REGISTRY_RETENTION_MS = 10080 * 6e4;
const info = theme.info;
function formatTaskLookupMiss(lookup) {
	return formatLookupMiss({
		noun: "Task",
		value: lookup,
		listCommand: "openclaw tasks list",
		valueLabel: "task id"
	});
}
async function loadTaskCancelConfig() {
	return getRuntimeConfig();
}
function configureTaskMaintenanceFromConfig() {
	configureTaskRegistryMaintenance({ cronStorePath: resolveCronStorePath(getRuntimeConfig().cron?.store) });
}
function parseCronRunSessionJobId(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return;
	return /^cron:([^:]+):run:[^:]+$/u.exec(parsed.rest)?.[1];
}
function readRunningCronJobIds() {
	try {
		const cronStorePath = resolveCronStorePath(getRuntimeConfig().cron?.store);
		return new Set(loadCronStoreSync(cronStorePath).jobs.filter((job) => typeof job.state?.runningAtMs === "number").map((job) => job.id.toLowerCase()));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function buildSessionRegistryPreserveKeys(params) {
	const preserveKeys = /* @__PURE__ */ new Set();
	let preservedRunning = 0;
	for (const key of Object.keys(params.store)) {
		const jobId = parseCronRunSessionJobId(key);
		if (!jobId) {
			preserveKeys.add(key);
			continue;
		}
		if (params.runningCronJobIds.has(jobId)) {
			preserveKeys.add(key);
			preservedRunning += 1;
		}
	}
	return {
		preserveKeys,
		preservedRunning
	};
}
async function runSessionRegistryMaintenance(params) {
	const cfg = getRuntimeConfig();
	const runningCronJobIds = readRunningCronJobIds();
	const stores = [];
	for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
		if (!fs.existsSync(target.storePath)) {
			stores.push({
				agentId: target.agentId,
				storePath: target.storePath,
				beforeCount: 0,
				afterCount: 0,
				pruned: 0,
				preservedRunning: 0
			});
			continue;
		}
		const beforeStore = loadSessionStore(target.storePath, { skipCache: true });
		const beforeCount = Object.keys(beforeStore).length;
		if (params.apply) {
			const applied = await updateSessionStore(target.storePath, (store) => {
				const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
					store,
					runningCronJobIds
				});
				return {
					pruned: pruneStaleEntries(store, SESSION_REGISTRY_RETENTION_MS, {
						log: false,
						preserveKeys
					}),
					afterCount: Object.keys(store).length,
					preservedRunning
				};
			}, { skipMaintenance: true });
			stores.push({
				agentId: target.agentId,
				storePath: target.storePath,
				beforeCount,
				afterCount: applied.afterCount,
				pruned: applied.pruned,
				preservedRunning: applied.preservedRunning
			});
			continue;
		}
		const previewStore = structuredClone(beforeStore);
		const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
			store: previewStore,
			runningCronJobIds
		});
		const pruned = pruneStaleEntries(previewStore, SESSION_REGISTRY_RETENTION_MS, {
			log: false,
			preserveKeys
		});
		stores.push({
			agentId: target.agentId,
			storePath: target.storePath,
			beforeCount,
			afterCount: Object.keys(previewStore).length,
			pruned,
			preservedRunning
		});
	}
	return {
		retentionMs: SESSION_REGISTRY_RETENTION_MS,
		runningCronJobs: runningCronJobIds.size,
		pruned: stores.reduce((total, store) => total + store.pruned, 0),
		stores
	};
}
function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 1)}…`;
}
function shortToken(value, maxChars = ID_PAD) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "n/a";
	return truncate(trimmed, maxChars);
}
function formatTaskStatusCell(status, rich) {
	const padded = status.padEnd(STATUS_PAD);
	if (!rich) return padded;
	if (status === "succeeded") return theme.success(padded);
	if (status === "failed" || status === "lost" || status === "timed_out") return theme.error(padded);
	if (status === "running") return theme.accentBright(padded);
	return theme.muted(padded);
}
function formatTaskRows(tasks, rich) {
	const header = [
		"Task".padEnd(ID_PAD),
		"Kind".padEnd(RUNTIME_PAD),
		"Status".padEnd(STATUS_PAD),
		"Delivery".padEnd(DELIVERY_PAD),
		"Run".padEnd(RUN_PAD),
		"Child Session",
		"Summary"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const task of tasks) {
		const summary = truncate(normalizeOptionalString(task.terminalSummary) || normalizeOptionalString(task.progressSummary) || normalizeOptionalString(task.label) || task.task.trim(), 80);
		const line = [
			shortToken(task.taskId).padEnd(ID_PAD),
			task.runtime.padEnd(RUNTIME_PAD),
			formatTaskStatusCell(task.status, rich),
			task.deliveryStatus.padEnd(DELIVERY_PAD),
			shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
			truncate(normalizeOptionalString(task.childSessionKey) || "n/a", 36).padEnd(36),
			summary
		].join(" ");
		lines.push(line.trimEnd());
	}
	return lines;
}
function formatTaskListSummary(tasks) {
	const summary = summarizeTaskRecords(tasks);
	return `${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${summary.failures} issues`;
}
function formatAgeMs(ageMs) {
	if (typeof ageMs !== "number" || ageMs < 1e3) return "fresh";
	const totalSeconds = Math.floor(ageMs / 1e3);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor(totalSeconds % 86400 / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${totalSeconds}s`;
}
function compareSystemAuditFindings(left, right) {
	return compareTaskAuditFindingSortKeys({
		severity: left.severity,
		ageMs: left.ageMs,
		createdAt: left.task?.createdAt ?? left.flow?.createdAt ?? 0
	}, {
		severity: right.severity,
		ageMs: right.ageMs,
		createdAt: right.task?.createdAt ?? right.flow?.createdAt ?? 0
	});
}
function formatAuditRows(findings, rich) {
	const header = [
		"Scope".padEnd(8),
		"Severity".padEnd(8),
		"Code".padEnd(22),
		"Item".padEnd(ID_PAD),
		"Status".padEnd(STATUS_PAD),
		"Age".padEnd(8),
		"Detail"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const finding of findings) {
		const severity = finding.severity.padEnd(8);
		const status = formatTaskStatusCell(finding.status ?? "n/a", rich);
		const severityCell = !rich ? severity : finding.severity === "error" ? theme.error(severity) : theme.warn(severity);
		const scope = finding.kind === "task" ? "Task" : "TaskFlow";
		lines.push([
			scope.padEnd(8),
			severityCell,
			finding.code.padEnd(22),
			shortToken(finding.token).padEnd(ID_PAD),
			status,
			formatAgeMs(finding.ageMs).padEnd(8),
			truncate(finding.detail, 88)
		].join(" ").trimEnd());
	}
	return lines;
}
function toSystemAuditFindings(params) {
	const taskFindings = listTaskAuditFindings({ tasks: reconcileInspectableTasks() });
	const flowFindings = listTaskFlowAuditFindings();
	const allFindings = [...taskFindings.map((finding) => ({
		kind: "task",
		severity: finding.severity,
		code: finding.code,
		detail: finding.detail,
		ageMs: finding.ageMs,
		status: finding.task.status,
		token: finding.task.taskId,
		task: finding.task
	})), ...flowFindings.map((finding) => ({
		kind: "task_flow",
		severity: finding.severity,
		code: finding.code,
		detail: finding.detail,
		ageMs: finding.ageMs,
		status: finding.flow?.status ?? "n/a",
		token: finding.flow?.flowId,
		...finding.flow ? { flow: finding.flow } : {}
	}))];
	const filteredFindings = allFindings.filter((finding) => {
		if (params.severityFilter && finding.severity !== params.severityFilter) return false;
		if (params.codeFilter && finding.code !== params.codeFilter) return false;
		return true;
	}).toSorted(compareSystemAuditFindings);
	const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
	return {
		allFindings: sortedAllFindings,
		filteredFindings,
		taskFindings,
		flowFindings,
		summary: {
			total: sortedAllFindings.length,
			errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
			warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
			tasks: summarizeTaskAuditFindings(taskFindings),
			taskFlows: summarizeTaskFlowAuditFindings(flowFindings)
		}
	};
}
async function tasksListCommand(opts, runtime) {
	const runtimeFilter = opts.runtime?.trim();
	const statusFilter = opts.status?.trim();
	const tasks = reconcileInspectableTasks().filter((task) => {
		if (runtimeFilter && task.runtime !== runtimeFilter) return false;
		if (statusFilter && task.status !== statusFilter) return false;
		return true;
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: tasks.length,
			runtime: runtimeFilter ?? null,
			status: statusFilter ?? null,
			tasks
		}, null, 2));
		return;
	}
	runtime.log(info(`Background tasks: ${tasks.length}`));
	runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
	if (runtimeFilter) runtime.log(info(`Runtime filter: ${runtimeFilter}`));
	if (statusFilter) runtime.log(info(`Status filter: ${statusFilter}`));
	if (tasks.length === 0) {
		runtime.log(`No background tasks found. Run ${formatCliCommand("openclaw tasks audit")} to check for stale task state.`);
		return;
	}
	const rich = isRich();
	for (const line of formatTaskRows(tasks, rich)) runtime.log(line);
}
async function tasksShowCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (opts.json) {
		runtime.log(JSON.stringify(task, null, 2));
		return;
	}
	const lines = [
		"Background task:",
		`taskId: ${task.taskId}`,
		`kind: ${task.runtime}`,
		`sourceId: ${task.sourceId ?? "n/a"}`,
		`status: ${task.status}`,
		`result: ${task.terminalOutcome ?? "n/a"}`,
		`delivery: ${task.deliveryStatus}`,
		`notify: ${task.notifyPolicy}`,
		`ownerKey: ${task.ownerKey}`,
		`childSessionKey: ${task.childSessionKey ?? "n/a"}`,
		`parentTaskId: ${task.parentTaskId ?? "n/a"}`,
		`agentId: ${task.agentId ?? "n/a"}`,
		`runId: ${task.runId ?? "n/a"}`,
		`label: ${task.label ?? "n/a"}`,
		`task: ${task.task}`,
		`createdAt: ${new Date(task.createdAt).toISOString()}`,
		`startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "n/a"}`,
		`endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : "n/a"}`,
		`lastEventAt: ${task.lastEventAt ? new Date(task.lastEventAt).toISOString() : "n/a"}`,
		`cleanupAfter: ${task.cleanupAfter ? new Date(task.cleanupAfter).toISOString() : "n/a"}`,
		...task.error ? [`error: ${task.error}`] : [],
		...task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : [],
		...task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []
	];
	for (const line of lines) runtime.log(line);
}
async function tasksNotifyCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const updated = updateTaskNotifyPolicyById({
		taskId: task.taskId,
		notifyPolicy: opts.notify
	});
	if (!updated) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	runtime.log(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`);
}
async function tasksCancelCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const result = await cancelDetachedTaskRunById({
		cfg: await loadTaskCancelConfig(),
		taskId: task.taskId
	});
	if (!result.found) {
		runtime.error(result.reason ?? formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (!result.cancelled) {
		runtime.error(result.reason ?? `Could not cancel task: ${opts.lookup}`);
		runtime.exit(1);
		return;
	}
	const updated = getTaskById(task.taskId);
	runtime.log(`Cancelled ${updated?.taskId ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`);
}
async function tasksAuditCommand(opts, runtime) {
	configureTaskMaintenanceFromConfig();
	const severityFilter = opts.severity?.trim();
	const codeFilter = opts.code?.trim();
	const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
		severityFilter,
		codeFilter
	});
	const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : void 0;
	const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
	if (opts.json) {
		const legacySummary = summarizeTaskAuditFindings(taskFindings);
		runtime.log(JSON.stringify({
			count: allFindings.length,
			filteredCount: filteredFindings.length,
			displayed: displayed.length,
			filters: {
				severity: severityFilter ?? null,
				code: codeFilter ?? null,
				limit: limit ?? null
			},
			summary: {
				...legacySummary,
				taskFlows: summary.taskFlows,
				combined: {
					total: summary.total,
					errors: summary.errors,
					warnings: summary.warnings
				}
			},
			findings: displayed
		}, null, 2));
		return;
	}
	runtime.log(info(`Tasks audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`));
	if (severityFilter || codeFilter) runtime.log(info(`Showing ${filteredFindings.length} matching findings.`));
	if (severityFilter) runtime.log(info(`Severity filter: ${severityFilter}`));
	if (codeFilter) runtime.log(info(`Code filter: ${codeFilter}`));
	if (limit) runtime.log(info(`Limit: ${limit}`));
	runtime.log(info(`Task findings: ${summary.tasks.total} · TaskFlow findings: ${summary.taskFlows.total}`));
	if (displayed.length === 0) {
		runtime.log("No tasks audit findings.");
		return;
	}
	const rich = isRich();
	for (const line of formatAuditRows(displayed, rich)) runtime.log(line);
}
async function tasksMaintenanceCommand(opts, runtime) {
	configureTaskMaintenanceFromConfig();
	const auditBefore = getInspectableTaskAuditSummary();
	const flowAuditBefore = getInspectableTaskFlowAuditSummary();
	const taskMaintenance = opts.apply ? await runTaskRegistryMaintenance() : previewTaskRegistryMaintenance();
	const flowMaintenance = opts.apply ? await runTaskFlowRegistryMaintenance() : previewTaskFlowRegistryMaintenance();
	const sessionMaintenance = await runSessionRegistryMaintenance({ apply: Boolean(opts.apply) });
	const summary = getInspectableTaskRegistrySummary();
	const auditAfter = opts.apply ? getInspectableTaskAuditSummary() : auditBefore;
	const flowAuditAfter = opts.apply ? getInspectableTaskFlowAuditSummary() : flowAuditBefore;
	if (opts.json) {
		runtime.log(JSON.stringify({
			mode: opts.apply ? "apply" : "preview",
			maintenance: {
				tasks: taskMaintenance,
				taskFlows: flowMaintenance,
				sessions: sessionMaintenance
			},
			tasks: summary,
			auditBefore: {
				...auditBefore,
				taskFlows: flowAuditBefore
			},
			auditAfter: {
				...auditAfter,
				taskFlows: flowAuditAfter
			}
		}, null, 2));
		return;
	}
	runtime.log(info(`Tasks maintenance (${opts.apply ? "applied" : "preview"}): tasks ${taskMaintenance.reconciled} reconcile · ${taskMaintenance.recovered} recovered · ${taskMaintenance.cleanupStamped} cleanup stamp · ${taskMaintenance.pruned} prune; task-flows ${flowMaintenance.reconciled} reconcile · ${flowMaintenance.pruned} prune`));
	runtime.log(info(`Session registry: ${sessionMaintenance.pruned} prune · ${sessionMaintenance.runningCronJobs} running cron jobs`));
	runtime.log(info(`${opts.apply ? "Tasks health after apply" : "Tasks health"}: ${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${auditAfter.errors + flowAuditAfter.errors} audit errors · ${auditAfter.warnings + flowAuditAfter.warnings} audit warnings`));
	if (opts.apply) runtime.log(info(`Tasks health before apply: ${auditBefore.errors + flowAuditBefore.errors} audit errors · ${auditBefore.warnings + flowAuditBefore.warnings} audit warnings`));
	if (!opts.apply) runtime.log("Dry run only. Re-run with `openclaw tasks maintenance --apply` to write changes.");
}
//#endregion
//#region src/cli/program/register.status-health-sessions.ts
function resolveVerbose(opts) {
	return Boolean(opts.verbose || opts.debug);
}
function parseTimeoutMs(timeout) {
	const parsed = parsePositiveIntOrUndefined(timeout);
	if (timeout !== void 0 && parsed === void 0) {
		defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
		defaultRuntime.exit(1);
		return null;
	}
	return parsed;
}
async function runWithVerboseAndTimeout(opts, action) {
	const verbose = resolveVerbose(opts);
	setVerbose(verbose);
	const timeoutMs = parseTimeoutMs(opts.timeout);
	if (timeoutMs === null) return;
	await runCommandWithRuntime(defaultRuntime, async () => {
		await action({
			verbose,
			timeoutMs
		});
	});
}
function registerStatusHealthSessionsCommands(program) {
	program.command("status").description("Show channel health and recent session recipients").option("--json", "Output JSON instead of text", false).option("--all", "Full diagnosis (read-only, pasteable)", false).option("--usage", "Show model provider usage/quota snapshots", false).option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false).option("--timeout <ms>", "Probe timeout in milliseconds", "10000").option("--verbose", "Verbose logging", false).option("--debug", "Alias for --verbose", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw status", "Show channel health + session summary."],
		["openclaw status --all", "Full diagnosis (read-only)."],
		["openclaw status --json", "Machine-readable output."],
		["openclaw status --usage", "Show model provider usage/quota snapshots."],
		["openclaw status --deep", "Run channel probes (WA + Telegram + Discord + Slack + Signal)."],
		["openclaw status --deep --timeout 5000", "Tighten probe timeout."]
	])}`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/status", "docs.openclaw.ai/cli/status")}\n`).action(async (opts) => {
		await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
			await statusCommand({
				json: Boolean(opts.json),
				all: Boolean(opts.all),
				deep: Boolean(opts.deep),
				usage: Boolean(opts.usage),
				timeoutMs,
				verbose
			}, defaultRuntime);
		});
	});
	program.command("health").description("Fetch health from the running gateway").option("--json", "Output JSON instead of text", false).option("--timeout <ms>", "Connection timeout in milliseconds", "10000").option("--verbose", "Verbose logging", false).option("--debug", "Alias for --verbose", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/health", "docs.openclaw.ai/cli/health")}\n`).action(async (opts) => {
		await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
			await healthCommand({
				json: Boolean(opts.json),
				timeoutMs,
				verbose
			}, defaultRuntime);
		});
	});
	const sessionsCmd = program.command("sessions").description("List stored conversation sessions").option("--json", "Output as JSON", false).option("--verbose", "Verbose logging", false).option("--store <path>", "Path to session store (default: resolved from config)").option("--agent <id>", "Agent id to inspect (default: configured default agent)").option("--all-agents", "Aggregate sessions across all configured agents", false).option("--active <minutes>", "Only show sessions updated within the past N minutes").option("--limit <count>", "Max sessions to show (default: 100; use \"all\" for full output)").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw sessions", "List all sessions."],
		["openclaw sessions --agent work", "List sessions for one agent."],
		["openclaw sessions --all-agents", "Aggregate sessions across agents."],
		["openclaw sessions --active 120", "Only last 2 hours."],
		["openclaw sessions --limit 25", "Show the newest 25 sessions."],
		["openclaw sessions --json", "Machine-readable output."],
		["openclaw sessions --store ./tmp/sessions.json", "Use a specific session store."]
	])}\n\n${theme.muted("Shows token usage per session when the agent reports it; set agents.defaults.contextTokens to cap the window and show %.")}`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sessions", "docs.openclaw.ai/cli/sessions")}\n`).action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		await sessionsCommand({
			json: Boolean(opts.json),
			store: opts.store,
			agent: opts.agent,
			allAgents: Boolean(opts.allAgents),
			active: opts.active,
			limit: opts.limit
		}, defaultRuntime);
	});
	sessionsCmd.enablePositionalOptions();
	sessionsCmd.command("cleanup").description("Run session-store maintenance now").option("--store <path>", "Path to session store (default: resolved from config)").option("--agent <id>", "Agent id to maintain (default: configured default agent)").option("--all-agents", "Run maintenance across all configured agents", false).option("--dry-run", "Preview maintenance actions without writing", false).option("--enforce", "Apply maintenance even when configured mode is warn", false).option("--fix-missing", "Remove store entries whose transcript files are missing (bypasses age/count retention)", false).option("--fix-dm-scope", "Retire stale direct-DM session rows that no longer match session.dmScope=main", false).option("--active-key <key>", "Protect this session key from budget-eviction").option("--json", "Output JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw sessions cleanup --dry-run", "Preview stale/cap cleanup."],
		["openclaw sessions cleanup --dry-run --fix-missing", "Also preview pruning entries with missing transcript files."],
		["openclaw sessions cleanup --dry-run --fix-dm-scope", "Preview stale direct-DM rows after returning dmScope to main."],
		["openclaw sessions cleanup --enforce", "Apply maintenance now."],
		["openclaw sessions cleanup --agent work --dry-run", "Preview one agent store."],
		["openclaw sessions cleanup --all-agents --dry-run", "Preview all agent stores."],
		["openclaw sessions cleanup --enforce --store ./tmp/sessions.json", "Use a specific store."]
	])}`).action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await sessionsCleanupCommand({
				store: opts.store ?? parentOpts?.store,
				agent: opts.agent ?? parentOpts?.agent,
				allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
				dryRun: Boolean(opts.dryRun),
				enforce: Boolean(opts.enforce),
				fixMissing: Boolean(opts.fixMissing),
				fixDmScope: Boolean(opts.fixDmScope),
				activeKey: opts.activeKey,
				json: Boolean(opts.json || parentOpts?.json)
			}, defaultRuntime);
		});
	});
	sessionsCmd.command("export-trajectory").description("Export a redacted trajectory bundle for a stored session").option("--session-key <key>", "Session key to export").option("--output <path>", "Output directory name inside .openclaw/trajectory-exports").option("--workspace <path>", "Workspace root for the export (default: current directory)").option("--store <path>", "Path to session store (default: resolved from session key)").option("--agent <id>", "Agent id for resolving the default session store").option("--request-json-base64 <payload>", "Base64url-encoded export request").option("--json", "Output JSON", false).action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await exportTrajectoryCommand({
				sessionKey: opts.sessionKey,
				output: opts.output,
				workspace: opts.workspace,
				store: opts.store ?? parentOpts?.store,
				agent: opts.agent ?? parentOpts?.agent,
				requestJsonBase64: opts.requestJsonBase64,
				json: Boolean(opts.json || parentOpts?.json)
			}, defaultRuntime);
		});
	});
	const commitmentsCmd = program.command("commitments").description("List and manage inferred follow-up commitments").option("--json", "Output JSON instead of text", false).option("--agent <id>", "Agent id to inspect").option("--status <status>", "Filter by status (pending, sent, dismissed, snoozed, expired)").option("--all", "Show all statuses", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw commitments", "List pending inferred follow-ups."],
		["openclaw commitments --all", "List all inferred follow-ups."],
		["openclaw commitments --agent work", "List one agent's inferred follow-ups."],
		["openclaw commitments dismiss cm_abc123", "Dismiss a follow-up."]
	])}`).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await commitmentsListCommand({
				json: Boolean(opts.json),
				agent: opts.agent,
				status: opts.status,
				all: Boolean(opts.all)
			}, defaultRuntime);
		});
	});
	commitmentsCmd.enablePositionalOptions();
	commitmentsCmd.command("list").description("List inferred follow-up commitments").option("--json", "Output JSON instead of text", false).option("--agent <id>", "Agent id to inspect").option("--status <status>", "Filter by status (pending, sent, dismissed, snoozed, expired)").option("--all", "Show all statuses", false).action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await commitmentsListCommand({
				json: Boolean(opts.json || parentOpts?.json),
				agent: opts.agent ?? parentOpts?.agent,
				status: opts.status ?? parentOpts?.status,
				all: Boolean(opts.all || parentOpts?.all)
			}, defaultRuntime);
		});
	});
	commitmentsCmd.command("dismiss <ids...>").description("Dismiss inferred follow-up commitments").option("--json", "Output JSON instead of text", false).action(async (ids, opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await commitmentsDismissCommand({
				ids,
				json: Boolean(opts.json || parentOpts?.json)
			}, defaultRuntime);
		});
	});
	const tasksCmd = program.command("tasks").description("Inspect durable background tasks and TaskFlow state").option("--json", "Output as JSON", false).option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)").option("--status <name>", "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksListCommand({
				json: Boolean(opts.json),
				runtime: opts.runtime,
				status: opts.status
			}, defaultRuntime);
		});
	});
	tasksCmd.enablePositionalOptions();
	tasksCmd.command("list").description("List tracked background tasks").option("--json", "Output as JSON", false).option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)").option("--status <name>", "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)").action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksListCommand({
				json: Boolean(opts.json || parentOpts?.json),
				runtime: opts.runtime ?? parentOpts?.runtime,
				status: opts.status ?? parentOpts?.status
			}, defaultRuntime);
		});
	});
	tasksCmd.command("audit").description("Show stale or broken background tasks and TaskFlows").option("--json", "Output as JSON", false).option("--severity <level>", "Filter by severity (warn, error)").option("--code <name>", "Filter by finding code (stale_queued, stale_running, lost, delivery_failed, missing_cleanup, inconsistent_timestamps, restore_failed, stale_waiting, stale_blocked, cancel_stuck, missing_linked_tasks, blocked_task_missing)").option("--limit <n>", "Limit displayed findings").action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksAuditCommand({
				json: Boolean(opts.json || parentOpts?.json),
				severity: opts.severity,
				code: opts.code,
				limit: parsePositiveIntOrUndefined(opts.limit)
			}, defaultRuntime);
		});
	});
	tasksCmd.command("maintenance").description("Preview or apply tasks and TaskFlow maintenance").option("--json", "Output as JSON", false).option("--apply", "Apply reconciliation, cleanup stamping, and pruning", false).action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksMaintenanceCommand({
				json: Boolean(opts.json || parentOpts?.json),
				apply: Boolean(opts.apply)
			}, defaultRuntime);
		});
	});
	tasksCmd.command("show").description("Show one background task by task id, run id, or session key").argument("<lookup>", "Task id, run id, or session key").option("--json", "Output as JSON", false).action(async (lookup, opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksShowCommand({
				lookup,
				json: Boolean(opts.json || parentOpts?.json)
			}, defaultRuntime);
		});
	});
	tasksCmd.command("notify").description("Set task notify policy").argument("<lookup>", "Task id, run id, or session key").argument("<notify>", "Notify policy (done_only, state_changes, silent)").action(async (lookup, notify) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksNotifyCommand({
				lookup,
				notify
			}, defaultRuntime);
		});
	});
	tasksCmd.command("cancel").description("Cancel a running background task").argument("<lookup>", "Task id, run id, or session key").action(async (lookup) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await tasksCancelCommand({ lookup }, defaultRuntime);
		});
	});
	const tasksFlowCmd = tasksCmd.command("flow").description("Inspect durable TaskFlow state under tasks");
	tasksFlowCmd.command("list").description("List tracked TaskFlows").option("--json", "Output as JSON", false).option("--status <name>", "Filter by status (queued, running, waiting, blocked, succeeded, failed, cancelled, lost)").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await flowsListCommand({
				json: Boolean(opts.json),
				status: opts.status
			}, defaultRuntime);
		});
	});
	tasksFlowCmd.command("show").description("Show one TaskFlow by flow id or owner key").argument("<lookup>", "Flow id or owner key").option("--json", "Output as JSON", false).action(async (lookup, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await flowsShowCommand({
				lookup,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	tasksFlowCmd.command("cancel").description("Cancel a running TaskFlow").argument("<lookup>", "Flow id or owner key").action(async (lookup) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await flowsCancelCommand({ lookup }, defaultRuntime);
		});
	});
}
//#endregion
export { registerStatusHealthSessionsCommands };
