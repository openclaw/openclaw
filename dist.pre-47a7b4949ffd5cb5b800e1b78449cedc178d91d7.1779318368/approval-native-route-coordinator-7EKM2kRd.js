import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatHumanList } from "./human-list-BmpwDy18.js";
import { t as buildChannelApprovalNativeTargetKey } from "./approval-native-target-key-D2RQhpuG.js";
//#region src/infra/approval-native-route-notice.ts
function describeApprovalDeliveryDestination(params) {
	const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
	return surfaces.size === 1 && surfaces.has("approver-dm") ? `${params.channelLabel} DMs` : params.channelLabel;
}
function resolveApprovalRoutedElsewhereNoticeText(destinations) {
	const uniqueDestinations = Array.from(new Set(destinations.map((value) => value.trim()))).filter(Boolean);
	if (uniqueDestinations.length === 0) return null;
	return `Approval required. I sent the approval request to ${formatHumanList(uniqueDestinations.toSorted((a, b) => a.localeCompare(b)))}, not this chat.`;
}
function resolveApprovalDeliveryFailedNoticeText(params) {
	return [
		"Approval required. I could not deliver the native approval request.",
		`Reply with: /approve ${params.approvalKind === "exec" && params.approvalId.length > 8 ? params.approvalId.slice(0, 8) : params.approvalId} ${(params.allowedDecisions?.length ? params.allowedDecisions : [
			"allow-once",
			"allow-always",
			"deny"
		]).join("|")}`,
		"If the short code is ambiguous, use the full id in /approve."
	].join("\n");
}
//#endregion
//#region src/infra/approval-native-route-coordinator.ts
const activeApprovalRouteRuntimes = /* @__PURE__ */ new Map();
const pendingApprovalRouteNotices = /* @__PURE__ */ new Map();
let approvalRouteRuntimeSeq = 0;
const MAX_APPROVAL_ROUTE_NOTICE_TTL_MS = 5 * 6e4;
function normalizeChannel(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function clearPendingApprovalRouteNotice(approvalId) {
	const entry = pendingApprovalRouteNotices.get(approvalId);
	if (!entry) return;
	pendingApprovalRouteNotices.delete(approvalId);
	if (entry.cleanupTimeout) clearTimeout(entry.cleanupTimeout);
}
function createPendingApprovalRouteNotice(params) {
	const timeoutMs = Math.min(Math.max(0, params.request.expiresAtMs - Date.now()), MAX_APPROVAL_ROUTE_NOTICE_TTL_MS);
	const cleanupTimeout = setTimeout(() => {
		clearPendingApprovalRouteNotice(params.request.id);
	}, timeoutMs);
	cleanupTimeout.unref?.();
	return {
		request: params.request,
		approvalKind: params.approvalKind,
		expectedRuntimeIds: new Set(params.expectedRuntimeIds ?? []),
		reports: /* @__PURE__ */ new Map(),
		cleanupTimeout,
		finalized: false
	};
}
function resolveRouteNoticeTargetFromRequest(request) {
	const channel = request.request.turnSourceChannel?.trim();
	const to = request.request.turnSourceTo?.trim();
	if (!channel || !to) return null;
	return {
		channel,
		to,
		accountId: request.request.turnSourceAccountId ?? void 0,
		threadId: request.request.turnSourceThreadId ?? void 0
	};
}
function resolveFallbackRouteNoticeTarget(report) {
	const channel = report.channel?.trim();
	const to = report.deliveryPlan.originTarget?.to?.trim();
	if (!channel || !to) return null;
	return {
		channel,
		to,
		accountId: report.accountId ?? void 0,
		threadId: report.deliveryPlan.originTarget?.threadId ?? void 0
	};
}
function didReportDeliverToOrigin(report, originAccountId) {
	const originTarget = report.deliveryPlan.originTarget;
	if (!originTarget) return false;
	const reportAccountId = normalizeOptionalString(report.accountId);
	if (originAccountId !== void 0 && reportAccountId !== void 0 && reportAccountId !== originAccountId) return false;
	const originKey = buildChannelApprovalNativeTargetKey(originTarget);
	return report.deliveredTargets.some((plannedTarget) => buildChannelApprovalNativeTargetKey(plannedTarget.target) === originKey);
}
function hasPlannedNativeTargets(report) {
	return report.deliveryPlan.targets.length > 0;
}
function readAllowedDecisionStrings(request) {
	const allowedDecisions = "allowedDecisions" in request.request ? request.request.allowedDecisions : void 0;
	if (!Array.isArray(allowedDecisions)) return;
	return allowedDecisions.filter((value) => typeof value === "string");
}
function resolveApprovalRouteNotice(params) {
	const explicitTarget = resolveRouteNoticeTargetFromRequest(params.request);
	const originChannel = normalizeChannel(explicitTarget?.channel ?? params.request.request.turnSourceChannel);
	const fallbackTarget = params.reports.filter((report) => normalizeChannel(report.channel) === originChannel || !originChannel).map(resolveFallbackRouteNoticeTarget).find((target) => target !== null) ?? null;
	const target = explicitTarget ? {
		...fallbackTarget,
		...explicitTarget,
		accountId: explicitTarget.accountId ?? fallbackTarget?.accountId,
		threadId: explicitTarget.threadId ?? fallbackTarget?.threadId
	} : fallbackTarget;
	if (!target) return null;
	const originAccountId = normalizeOptionalString(target.accountId);
	if (!params.reports.some((report) => report.deliveredTargets.length > 0) && params.reports.some(hasPlannedNativeTargets)) return {
		requestGateway: params.reports.find((report) => activeApprovalRouteRuntimes.has(report.runtimeId))?.requestGateway ?? params.reports[0].requestGateway,
		target,
		text: resolveApprovalDeliveryFailedNoticeText({
			approvalId: params.request.id,
			approvalKind: params.approvalKind,
			allowedDecisions: readAllowedDecisionStrings(params.request)
		})
	};
	if (params.reports.some((report) => {
		if (originChannel && normalizeChannel(report.channel) !== originChannel) return false;
		return didReportDeliverToOrigin(report, originAccountId);
	})) return null;
	const text = resolveApprovalRoutedElsewhereNoticeText(params.reports.flatMap((report) => {
		if (!report.channelLabel || report.deliveredTargets.length === 0) return [];
		const reportChannel = normalizeChannel(report.channel);
		if (originChannel && reportChannel === originChannel && !report.deliveryPlan.notifyOriginWhenDmOnly) return [];
		const reportAccountId = normalizeOptionalString(report.accountId);
		if (originChannel && reportChannel === originChannel && originAccountId !== void 0 && reportAccountId !== void 0 && reportAccountId !== originAccountId) return [];
		return [describeApprovalDeliveryDestination({
			channelLabel: report.channelLabel,
			deliveredTargets: report.deliveredTargets
		})];
	}));
	if (!text) return null;
	const requestGateway = params.reports.find((report) => activeApprovalRouteRuntimes.has(report.runtimeId))?.requestGateway ?? params.reports[0]?.requestGateway;
	if (!requestGateway) return null;
	return {
		requestGateway,
		target,
		text
	};
}
function hasActiveApprovalNativeRouteRuntime(params) {
	const channel = normalizeChannel(params.channel);
	const accountId = normalizeOptionalString(params.accountId);
	return Array.from(activeApprovalRouteRuntimes.values()).some((runtime) => {
		if (!runtime.handledKinds.has(params.approvalKind)) return false;
		if (channel && normalizeChannel(runtime.channel) !== channel) return false;
		const runtimeAccountId = normalizeOptionalString(runtime.accountId);
		return accountId === void 0 || runtimeAccountId === void 0 || runtimeAccountId === accountId;
	});
}
async function maybeFinalizeApprovalRouteNotice(approvalId) {
	const entry = pendingApprovalRouteNotices.get(approvalId);
	if (!entry || entry.finalized) return;
	for (const runtimeId of entry.expectedRuntimeIds) if (!entry.reports.has(runtimeId)) return;
	entry.finalized = true;
	const reports = Array.from(entry.reports.values());
	const notice = resolveApprovalRouteNotice({
		approvalKind: entry.approvalKind,
		request: entry.request,
		reports
	});
	clearPendingApprovalRouteNotice(approvalId);
	if (!notice) return;
	try {
		await notice.requestGateway("send", {
			channel: notice.target.channel,
			to: notice.target.to,
			accountId: notice.target.accountId ?? void 0,
			threadId: notice.target.threadId ?? void 0,
			message: notice.text,
			idempotencyKey: `approval-route-notice:${approvalId}`
		});
	} catch {}
}
function createApprovalNativeRouteReporter(params) {
	const runtimeId = `native-approval-route:${++approvalRouteRuntimeSeq}`;
	let registered = false;
	const report = async (payload) => {
		if (!registered || !params.handledKinds.has(payload.approvalKind)) return;
		const entry = pendingApprovalRouteNotices.get(payload.request.id) ?? createPendingApprovalRouteNotice({
			request: payload.request,
			approvalKind: payload.approvalKind,
			expectedRuntimeIds: [runtimeId]
		});
		entry.expectedRuntimeIds.add(runtimeId);
		entry.reports.set(runtimeId, {
			runtimeId,
			request: payload.request,
			channel: params.channel,
			channelLabel: params.channelLabel,
			accountId: params.accountId,
			deliveryPlan: payload.deliveryPlan,
			deliveredTargets: payload.deliveredTargets,
			requestGateway: params.requestGateway
		});
		pendingApprovalRouteNotices.set(payload.request.id, entry);
		await maybeFinalizeApprovalRouteNotice(payload.request.id);
	};
	return {
		observeRequest(payload) {
			if (!registered || !params.handledKinds.has(payload.approvalKind)) return;
			const entry = pendingApprovalRouteNotices.get(payload.request.id) ?? createPendingApprovalRouteNotice({
				request: payload.request,
				approvalKind: payload.approvalKind,
				expectedRuntimeIds: Array.from(activeApprovalRouteRuntimes.values()).filter((runtime) => runtime.handledKinds.has(payload.approvalKind)).map((runtime) => runtime.runtimeId)
			});
			entry.expectedRuntimeIds.add(runtimeId);
			pendingApprovalRouteNotices.set(payload.request.id, entry);
		},
		start() {
			if (registered) return;
			activeApprovalRouteRuntimes.set(runtimeId, {
				runtimeId,
				handledKinds: params.handledKinds,
				channel: params.channel,
				channelLabel: params.channelLabel,
				accountId: params.accountId,
				requestGateway: params.requestGateway
			});
			registered = true;
		},
		async reportSkipped(params) {
			await report({
				approvalKind: params.approvalKind,
				request: params.request,
				deliveryPlan: {
					targets: [],
					originTarget: null,
					notifyOriginWhenDmOnly: false
				},
				deliveredTargets: []
			});
		},
		async reportDelivery(params) {
			await report(params);
		},
		async stop() {
			if (!registered) return;
			registered = false;
			activeApprovalRouteRuntimes.delete(runtimeId);
			for (const entry of pendingApprovalRouteNotices.values()) {
				entry.expectedRuntimeIds.delete(runtimeId);
				if (entry.expectedRuntimeIds.size === 0) {
					clearPendingApprovalRouteNotice(entry.request.id);
					continue;
				}
				await maybeFinalizeApprovalRouteNotice(entry.request.id);
			}
		}
	};
}
//#endregion
export { hasActiveApprovalNativeRouteRuntime as n, createApprovalNativeRouteReporter as t };
