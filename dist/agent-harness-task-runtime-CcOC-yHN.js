import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import "./message-channel-CYCKkVrh.js";
import { So as AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./protocol-DiXjp30g.js";
import { f as listTaskRecords } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { c as recordTaskRunProgressByRunId, i as createRunningTaskRun, l as setDetachedTaskDeliveryStatusByRunId, o as finalizeTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { n as isInternalAnnounceRequesterSession, o as resolveSubagentCompletionOrigin, r as loadRequesterSessionEntry, t as deliverSubagentAnnouncement } from "./subagent-announce-delivery-p160OmJs.js";
import { n as formatAgentInternalEventsForPrompt } from "./internal-events-yCBm9zLb.js";
import { n as buildAnnounceIdempotencyKey } from "./announce-idempotency-DV6_8Blm.js";
import { t as assertAgentHarnessTaskRuntimeScope } from "./agent-harness-task-runtime-scope-ONSMbh2U.js";
import { t as resolveAnnounceOrigin } from "./subagent-announce-origin-boXMvsL2.js";
//#region src/plugin-sdk/agent-harness-task-runtime.ts
const AGENT_HARNESS_COMPLETION_SOURCE_TOOL = "agent_harness_task";
function createAgentHarnessTaskRuntime(params) {
	const runtime = params.runtime;
	const requesterSessionKey = assertAgentHarnessTaskRuntimeScope(params.scope).requesterSessionKey;
	const taskKind = normalizeOptionalString(params.taskKind);
	const runIdPrefix = normalizeOptionalString(params.runIdPrefix);
	const assertRunId = (runId) => assertScopedRunId(runId, runIdPrefix);
	return {
		createRunningTaskRun(taskParams) {
			assertRunId(taskParams.runId);
			return createRunningTaskRun({
				...taskParams,
				runtime,
				...taskKind ? { taskKind } : {},
				requesterSessionKey,
				ownerKey: requesterSessionKey,
				scopeKind: "session"
			});
		},
		recordTaskRunProgressByRunId(taskParams) {
			assertRunId(taskParams.runId);
			return recordTaskRunProgressByRunId({
				...taskParams,
				runtime,
				sessionKey: requesterSessionKey
			});
		},
		finalizeTaskRunByRunId(taskParams) {
			assertRunId(taskParams.runId);
			return finalizeTaskRunByRunId({
				...taskParams,
				runtime,
				sessionKey: requesterSessionKey
			});
		},
		setDetachedTaskDeliveryStatusByRunId(taskParams) {
			assertRunId(taskParams.runId);
			return setDetachedTaskDeliveryStatusByRunId({
				...taskParams,
				runtime,
				sessionKey: requesterSessionKey
			});
		},
		listTaskRecords() {
			return listTaskRecords().filter((task) => task.runtime === runtime && (!taskKind || task.taskKind === taskKind) && task.scopeKind === "session" && task.ownerKey === requesterSessionKey && (!runIdPrefix || task.runId?.startsWith(runIdPrefix)));
		}
	};
}
async function deliverAgentHarnessTaskCompletion(params) {
	const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
	const requesterSessionKey = scope.requesterSessionKey;
	const childSessionKey = params.childSessionKey.trim();
	const childSessionId = params.childSessionId.trim();
	const taskLabel = params.taskLabel?.trim() || "Agent harness task";
	const announceType = params.announceType?.trim() || "Agent harness task";
	const statusLabel = params.statusLabel?.trim() || params.status;
	const eventStatus = mapHarnessCompletionStatus(params.status);
	const requesterIsSubagent = isInternalAnnounceRequesterSession(requesterSessionKey);
	let directOrigin = scope.requesterOrigin;
	if (!requesterIsSubagent) {
		const { entry } = loadRequesterSessionEntry(requesterSessionKey);
		directOrigin = resolveAnnounceOrigin(entry, scope.requesterOrigin);
	}
	const completionDirectOrigin = requesterIsSubagent || !directOrigin ? directOrigin : await resolveSubagentCompletionOrigin({
		childSessionKey,
		requesterSessionKey,
		requesterOrigin: directOrigin,
		childRunId: childSessionKey,
		spawnMode: "run",
		expectsCompletionMessage: true
	});
	const internalEvents = [{
		type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
		source: "subagent",
		childSessionKey,
		childSessionId,
		announceType,
		taskLabel,
		status: eventStatus,
		statusLabel,
		result: params.result,
		replyInstruction: params.replyInstruction?.trim() || "Use the completed harness task result to continue or wrap up the parent task. If this is a channel session, send the visible response with the message tool instead of only writing a transcript final answer."
	}];
	const prompt = formatAgentInternalEventsForPrompt(internalEvents);
	return await deliverSubagentAnnouncement({
		requesterSessionKey,
		announceId: params.announceId,
		triggerMessage: prompt,
		steerMessage: prompt,
		internalEvents,
		summaryLine: taskLabel,
		requesterSessionOrigin: scope.requesterOrigin,
		requesterOrigin: completionDirectOrigin ?? directOrigin,
		completionDirectOrigin: completionDirectOrigin ?? directOrigin,
		directOrigin,
		sourceSessionKey: childSessionKey,
		sourceChannel: INTERNAL_MESSAGE_CHANNEL,
		sourceTool: AGENT_HARNESS_COMPLETION_SOURCE_TOOL,
		targetRequesterSessionKey: requesterSessionKey,
		requesterIsSubagent,
		expectsCompletionMessage: true,
		bestEffortDeliver: true,
		directIdempotencyKey: buildAnnounceIdempotencyKey(params.announceId),
		signal: params.signal
	});
}
function mapHarnessCompletionStatus(status) {
	if (status === "succeeded") return "ok";
	return "error";
}
function isDurableAgentHarnessCompletionDelivery(delivery) {
	if (!delivery.delivered) return false;
	if (delivery.path === "steered") return true;
	if (delivery.path !== "direct") return false;
	const phases = Array.isArray(delivery.phases) ? delivery.phases : void 0;
	if (!phases) return true;
	return phases.some((phase) => phase.phase === "direct-primary" && phase.delivered && phase.path === "direct");
}
function normalizeOptionalString(value) {
	return value?.trim() || void 0;
}
function assertScopedRunId(runId, runIdPrefix) {
	const normalized = runId.trim();
	if (!normalized) throw new Error("Agent harness task runtime requires runId");
	if (runIdPrefix && !normalized.startsWith(runIdPrefix)) throw new Error("Agent harness task runId is outside the configured scope");
}
//#endregion
export { deliverAgentHarnessTaskCompletion as n, isDurableAgentHarnessCompletionDelivery as r, createAgentHarnessTaskRuntime as t };
