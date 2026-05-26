import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { Ni as ErrorCodes, Pi as errorShape } from "./protocol-DiXjp30g.js";
import "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { r as resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface-CsyFP7mh.js";
//#region src/infra/approval-turn-source.ts
function hasApprovalTurnSourceRoute(params) {
	if (!params.turnSourceChannel?.trim()) return false;
	return resolveExecApprovalInitiatingSurfaceState({
		channel: params.turnSourceChannel,
		accountId: params.turnSourceAccountId,
		cfg: getRuntimeConfig()
	}).kind === "enabled";
}
//#endregion
//#region src/gateway/server-methods/approval-shared.ts
const APPROVAL_NOT_FOUND_DETAILS = {
	reason: ErrorCodes.APPROVAL_NOT_FOUND,
	remediation: "Re-request the action; pending approvals are cleared after expiry or restart."
};
const APPROVAL_ALREADY_RESOLVED_DETAILS = { reason: "APPROVAL_ALREADY_RESOLVED" };
function resolveRecordedApprovalDecision(record) {
	return record.decision ?? record.consumedDecision;
}
function isPromiseLike(value) {
	return typeof value === "object" && value !== null && "then" in value;
}
function isApprovalDecision(value) {
	return value === "allow-once" || value === "allow-always" || value === "deny";
}
function respondUnknownOrExpiredApproval(respond) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", { details: APPROVAL_NOT_FOUND_DETAILS }));
}
function resolvePendingApprovalLookupError(params) {
	if (params.resolvedId.kind === "none") return "missing";
	if (params.resolvedId.kind === "ambiguous" && !params.exposeAmbiguousPrefixError) return "missing";
	return {
		code: ErrorCodes.INVALID_REQUEST,
		message: "ambiguous approval id prefix; use the full id"
	};
}
function normalizeApprovalIdentity(value) {
	return normalizeOptionalString(value) ?? null;
}
function isApprovalRecordVisibleToClient(params) {
	const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
	if (scopes.includes("operator.admin")) return true;
	const requestedByDeviceId = normalizeApprovalIdentity(params.record.requestedByDeviceId);
	const requestedByClientId = normalizeApprovalIdentity(params.record.requestedByClientId);
	if (scopes.includes("operator.approvals") && params.client?.internal?.approvalRuntime === true) return true;
	if (requestedByDeviceId) return requestedByDeviceId === normalizeApprovalIdentity(params.client?.connect?.device?.id);
	const requestedByConnId = normalizeApprovalIdentity(params.record.requestedByConnId);
	if (requestedByConnId) return requestedByConnId === normalizeApprovalIdentity(params.client?.connId);
	if (requestedByClientId) return false;
	return true;
}
function resolveApprovalRequestRecipientConnIds(params) {
	return params.context.getApprovalClientConnIds?.({
		excludeConnId: params.excludeConnId,
		record: params.record,
		filter: (client) => isApprovalRecordVisibleToClient({
			record: params.record,
			client
		})
	}) ?? null;
}
function resolvePendingApprovalRecord(params) {
	const resolvedId = params.manager.lookupApprovalId(params.inputId, { filter: (record) => isApprovalRecordVisibleToClient({
		record,
		client: params.client ?? null
	}) });
	if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") return {
		ok: false,
		response: resolvePendingApprovalLookupError({
			resolvedId,
			exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError
		})
	};
	const snapshot = params.manager.getSnapshot(resolvedId.id);
	if (!snapshot || snapshot.resolvedAtMs !== void 0) return {
		ok: false,
		response: "missing"
	};
	return {
		ok: true,
		approvalId: resolvedId.id,
		snapshot
	};
}
function resolveResolvedApprovalRecord(params) {
	const resolvedId = params.manager.lookupApprovalId(params.inputId, {
		includeResolved: true,
		filter: (record) => isApprovalRecordVisibleToClient({
			record,
			client: params.client ?? null
		})
	});
	if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") return {
		ok: false,
		response: resolvePendingApprovalLookupError({
			resolvedId,
			exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError
		})
	};
	const snapshot = params.manager.getSnapshot(resolvedId.id);
	if (!snapshot || snapshot.resolvedAtMs === void 0) return {
		ok: false,
		response: "missing"
	};
	return {
		ok: true,
		approvalId: resolvedId.id,
		snapshot
	};
}
function respondPendingApprovalLookupError(params) {
	if (params.response === "missing") {
		respondUnknownOrExpiredApproval(params.respond);
		return;
	}
	params.respond(false, void 0, errorShape(params.response.code, params.response.message));
}
async function handleApprovalWaitDecision(params) {
	const id = normalizeOptionalString(params.inputId) ?? "";
	if (!id) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
		return;
	}
	const snapshot = params.manager.getSnapshot(id);
	if (!snapshot || !isApprovalRecordVisibleToClient({
		record: snapshot,
		client: params.client ?? null
	})) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"));
		return;
	}
	const decisionPromise = params.manager.awaitDecision(id);
	if (!decisionPromise) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"));
		return;
	}
	const decision = await decisionPromise;
	params.respond(true, {
		id,
		decision,
		createdAtMs: snapshot?.createdAtMs,
		expiresAtMs: snapshot?.expiresAtMs
	}, void 0);
}
async function handlePendingApprovalRequest(params) {
	const approvalClientConnIds = resolveApprovalRequestRecipientConnIds({
		context: params.context,
		record: params.record,
		excludeConnId: params.clientConnId
	});
	if (approvalClientConnIds) params.context.broadcastToConnIds(params.requestEventName, params.requestEvent, approvalClientConnIds, { dropIfSlow: true });
	else params.context.broadcast(params.requestEventName, params.requestEvent, { dropIfSlow: true });
	const hasApprovalClients = approvalClientConnIds !== null ? approvalClientConnIds.size > 0 : params.context.hasExecApprovalClients?.(params.clientConnId) ?? false;
	const deliveredResult = params.deliverRequest();
	const delivered = isPromiseLike(deliveredResult) ? await deliveredResult : deliveredResult;
	const hasTurnSourceRoute = !hasApprovalClients && !delivered && hasApprovalTurnSourceRoute({
		turnSourceChannel: params.record.request.turnSourceChannel,
		turnSourceAccountId: params.record.request.turnSourceAccountId
	});
	if (!hasApprovalClients && !hasTurnSourceRoute && !delivered) {
		params.manager.expire(params.record.id, "no-approval-route");
		params.respond(true, {
			id: params.record.id,
			decision: null,
			createdAtMs: params.record.createdAtMs,
			expiresAtMs: params.record.expiresAtMs
		}, void 0);
		return;
	}
	if (params.twoPhase) params.respond(true, {
		status: "accepted",
		id: params.record.id,
		createdAtMs: params.record.createdAtMs,
		expiresAtMs: params.record.expiresAtMs
	}, void 0);
	const decision = await params.decisionPromise;
	if (params.afterDecision) try {
		await params.afterDecision(decision, params.requestEvent);
	} catch (err) {
		params.context.logGateway?.error?.(`${params.afterDecisionErrorLabel ?? "approval follow-up failed"}: ${String(err)}`);
	}
	params.respond(true, {
		id: params.record.id,
		decision,
		createdAtMs: params.record.createdAtMs,
		expiresAtMs: params.record.expiresAtMs
	}, void 0);
}
async function handleApprovalResolve(params) {
	const resolved = resolvePendingApprovalRecord({
		manager: params.manager,
		inputId: params.inputId,
		client: params.client,
		exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError
	});
	if (!resolved.ok) {
		const resolvedRepeat = resolveResolvedApprovalRecord({
			manager: params.manager,
			inputId: params.inputId,
			client: params.client,
			exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError
		});
		if (resolvedRepeat.ok) {
			if (resolveRecordedApprovalDecision(resolvedRepeat.snapshot) === params.decision) {
				params.respond(true, { ok: true }, void 0);
				return;
			}
			params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", { details: APPROVAL_ALREADY_RESOLVED_DETAILS }));
			return;
		}
		respondPendingApprovalLookupError({
			respond: params.respond,
			response: resolved.response
		});
		return;
	}
	const validationError = params.validateDecision?.(resolved.snapshot);
	if (validationError) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, validationError.message, validationError.details ? { details: validationError.details } : void 0));
		return;
	}
	const resolvedBy = params.client?.connect?.client?.displayName ?? params.client?.connect?.client?.id ?? null;
	if (!params.manager.resolve(resolved.approvalId, params.decision, resolvedBy)) {
		respondUnknownOrExpiredApproval(params.respond);
		return;
	}
	const resolvedEvent = params.buildResolvedEvent({
		approvalId: resolved.approvalId,
		decision: params.decision,
		resolvedBy,
		snapshot: resolved.snapshot,
		nowMs: Date.now()
	});
	const resolvedEventConnIds = resolveApprovalRequestRecipientConnIds({
		context: params.context,
		record: resolved.snapshot
	});
	if (resolvedEventConnIds) params.context.broadcastToConnIds(params.resolvedEventName, resolvedEvent, resolvedEventConnIds, { dropIfSlow: true });
	else params.context.broadcast(params.resolvedEventName, resolvedEvent, { dropIfSlow: true });
	const followUps = [params.forwardResolved ? {
		run: params.forwardResolved,
		errorLabel: params.forwardResolvedErrorLabel ?? "approval resolve follow-up failed"
	} : null, ...params.extraResolvedHandlers ?? []].filter((entry) => Boolean(entry));
	for (const followUp of followUps) try {
		await followUp.run(resolvedEvent);
	} catch (err) {
		params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(err)}`);
	}
	params.respond(true, { ok: true }, void 0);
}
//#endregion
export { isApprovalRecordVisibleToClient as a, respondPendingApprovalLookupError as c, isApprovalDecision as i, handleApprovalWaitDecision as n, resolveApprovalRequestRecipientConnIds as o, handlePendingApprovalRequest as r, resolvePendingApprovalRecord as s, handleApprovalResolve as t };
