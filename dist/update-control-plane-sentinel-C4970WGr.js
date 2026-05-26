import { a as markUpdateRestartSentinelFailure, d as writeRestartSentinel, r as formatDoctorNonInteractiveHint, t as buildRestartSuccessContinuation } from "./restart-sentinel-BDtpdKoy.js";
import fs from "node:fs/promises";
//#region src/infra/update-restart-sentinel-payload.ts
function buildUpdateRestartSentinelPayload(params) {
	const { result, meta } = params;
	const continuation = result.status === "ok" ? buildRestartSuccessContinuation({
		sessionKey: meta.sessionKey,
		continuationMessage: meta.continuationMessage
	}) : null;
	return {
		kind: "update",
		status: result.status,
		ts: params.nowMs ?? Date.now(),
		...meta.sessionKey ? { sessionKey: meta.sessionKey } : {},
		...meta.deliveryContext ? { deliveryContext: meta.deliveryContext } : {},
		...meta.threadId ? { threadId: meta.threadId } : {},
		message: meta.note ?? null,
		...continuation ? { continuation } : {},
		doctorHint: formatDoctorNonInteractiveHint(),
		stats: {
			mode: result.mode,
			...result.root ? { root: result.root } : {},
			...meta.handoffId ? { handoffId: meta.handoffId } : {},
			before: result.before ?? null,
			after: result.after ?? null,
			steps: result.steps.map((step) => ({
				name: step.name,
				command: step.command,
				cwd: step.cwd,
				durationMs: step.durationMs,
				log: {
					stdoutTail: step.stdoutTail ?? null,
					stderrTail: step.stderrTail ?? null,
					exitCode: step.exitCode ?? null
				}
			})),
			reason: result.reason ?? null,
			durationMs: result.durationMs
		}
	};
}
//#endregion
//#region src/infra/update-control-plane-sentinel.ts
const CONTROL_PLANE_UPDATE_SENTINEL_META_ENV = "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META";
const CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
const CONTROL_PLANE_UPDATE_PENDING_REASONS = new Set([CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON, CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON]);
function buildControlPlaneUpdateRestartHealthPendingResult(result) {
	return {
		status: "skipped",
		mode: result.mode,
		...result.root ? { root: result.root } : {},
		reason: CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
		...result.before ? { before: result.before } : {},
		...result.after ? { after: result.after } : {},
		steps: result.steps,
		durationMs: result.durationMs
	};
}
function isPendingControlPlaneUpdateRestartSentinel(payload) {
	const reason = payload.stats?.reason;
	return payload.kind === "update" && payload.status === "skipped" && typeof reason === "string" && CONTROL_PLANE_UPDATE_PENDING_REASONS.has(reason);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeText(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function normalizeMeta(value) {
	if (!isRecord(value)) return null;
	const sessionKey = normalizeText(value.sessionKey);
	const threadId = normalizeText(value.threadId);
	const handoffId = normalizeText(value.handoffId);
	const channel = isRecord(value.deliveryContext) ? normalizeText(value.deliveryContext.channel) : void 0;
	const to = isRecord(value.deliveryContext) ? normalizeText(value.deliveryContext.to) : void 0;
	const accountId = isRecord(value.deliveryContext) ? normalizeText(value.deliveryContext.accountId) : void 0;
	const deliveryContext = channel || to || accountId ? {
		...channel ? { channel } : {},
		...to ? { to } : {},
		...accountId ? { accountId } : {}
	} : void 0;
	return {
		...sessionKey ? { sessionKey } : {},
		...deliveryContext ? { deliveryContext } : {},
		...threadId ? { threadId } : {},
		...handoffId ? { handoffId } : {},
		note: typeof value.note === "string" ? value.note : null,
		continuationMessage: typeof value.continuationMessage === "string" ? value.continuationMessage : null
	};
}
async function readControlPlaneUpdateSentinelMeta(env = process.env) {
	const filePath = env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]?.trim();
	if (!filePath) return null;
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed) || parsed.version !== 1) return null;
		return normalizeMeta(parsed.meta);
	} catch {
		return null;
	}
}
async function writeControlPlaneUpdateRestartSentinel(params) {
	return await writeRestartSentinel(buildUpdateRestartSentinelPayload({
		result: params.result,
		meta: params.meta
	}));
}
async function markControlPlaneUpdateRestartSentinelFailure(reason) {
	return (await markUpdateRestartSentinelFailure(reason))?.payload ?? null;
}
//#endregion
export { isPendingControlPlaneUpdateRestartSentinel as a, writeControlPlaneUpdateRestartSentinel as c, buildControlPlaneUpdateRestartHealthPendingResult as i, buildUpdateRestartSentinelPayload as l, CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON as n, markControlPlaneUpdateRestartSentinelFailure as o, CONTROL_PLANE_UPDATE_SENTINEL_META_ENV as r, readControlPlaneUpdateSentinelMeta as s, CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON as t };
