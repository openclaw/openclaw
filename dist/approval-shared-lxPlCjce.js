import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { Ni as ErrorCodes, Pi as errorShape } from "./protocol-QC2mQFMN.js";
import { r as resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface-C3a0D8DV.js";
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
function resolvePendingApprovalRecord(params) {
	const resolvedId = params.manager.lookupPendingId(params.inputId);
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
	const resolvedId = params.manager.lookupApprovalId(params.inputId, { includeResolved: true });
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
	const decisionPromise = params.manager.awaitDecision(id);
	if (!decisionPromise) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"));
		return;
	}
	const snapshot = params.manager.getSnapshot(id);
	const decision = await decisionPromise;
	params.respond(true, {
		id,
		decision,
		createdAtMs: snapshot?.createdAtMs,
		expiresAtMs: snapshot?.expiresAtMs
	}, void 0);
}
async function handlePendingApprovalRequest(params) {
	params.context.broadcast(params.requestEventName, params.requestEvent, { dropIfSlow: true });
	const hasApprovalClients = params.context.hasExecApprovalClients?.(params.clientConnId) ?? false;
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
		exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError
	});
	if (!resolved.ok) {
		const resolvedRepeat = resolveResolvedApprovalRecord({
			manager: params.manager,
			inputId: params.inputId,
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
	params.context.broadcast(params.resolvedEventName, resolvedEvent, { dropIfSlow: true });
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
export { resolvePendingApprovalRecord as a, isApprovalDecision as i, handleApprovalWaitDecision as n, respondPendingApprovalLookupError as o, handlePendingApprovalRequest as r, handleApprovalResolve as t };
