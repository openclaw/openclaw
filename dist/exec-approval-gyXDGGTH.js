import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as GATEWAY_CLIENT_IDS } from "./client-info-BVWE_ra1.js";
import { Ni as ErrorCodes, Pi as errorShape, Q as validateExecApprovalResolveParams, X as validateExecApprovalGetParams, Z as validateExecApprovalRequestParams, t as formatValidationErrors } from "./protocol-DiXjp30g.js";
import { t as resolveExecCommandHighlighting } from "./exec-command-highlighting-BtXl3FtP.js";
import { i as detectCommandCarrierArgv, o as detectInlineEvalInSegments } from "./risks-GkUMojAA.js";
import { D as resolveExecApprovalRequestAllowedDecisions, E as resolveExecApprovalAllowedDecisions, r as DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "./exec-approvals-Bef7TPVc.js";
import { i as sanitizeExecApprovalWarningText, n as sanitizeExecApprovalDisplayText, r as sanitizeExecApprovalDisplayTextWithStatus, t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-DFkfeGi4.js";
import { t as analyzeCommandForPolicy } from "./policy-CGfDNTtE.js";
import { i as buildSystemRunApprovalEnvBinding, r as buildSystemRunApprovalBinding } from "./system-run-command-BT3YU9qx.js";
import { n as resolveSystemRunApprovalRequestContext } from "./system-run-approval-context-jl9czEM4.js";
import { a as isApprovalRecordVisibleToClient, c as respondPendingApprovalLookupError, i as isApprovalDecision, n as handleApprovalWaitDecision, r as handlePendingApprovalRequest, s as resolvePendingApprovalRecord, t as handleApprovalResolve } from "./approval-shared-D6QkOF6w.js";
//#region src/infra/command-analysis/explain.ts
function uniqueStrings(values) {
	return [...new Set(values)];
}
function summarizeCommandSegmentsForDisplay(segments) {
	const riskKinds = [];
	const warningLines = [];
	const inlineEval = detectInlineEvalInSegments(segments);
	if (inlineEval) {
		riskKinds.push("inline-eval");
		warningLines.push(`Contains inline-eval: ${inlineEval.normalizedExecutable} ${inlineEval.flag}`);
	}
	for (const segment of segments) {
		const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
		for (const hit of detectCommandCarrierArgv(effectiveArgv)) {
			riskKinds.push("command-carrier");
			warningLines.push(hit.flag ? `Contains command-carrier: ${hit.command} ${hit.flag}` : `Contains command-carrier: ${hit.command}`);
		}
	}
	return {
		commandCount: segments.length,
		nestedCommandCount: 0,
		riskKinds: uniqueStrings(riskKinds),
		warningLines: uniqueStrings(warningLines)
	};
}
function resolveCommandAnalysisSummaryForDisplay(params) {
	const analysis = params.host === "node" ? Array.isArray(params.commandArgv) && params.commandArgv.length > 0 ? analyzeCommandForPolicy({
		source: "argv",
		argv: params.commandArgv,
		cwd: params.cwd ?? void 0
	}) : null : analyzeCommandForPolicy({
		source: "shell",
		command: params.commandText,
		cwd: params.cwd ?? void 0
	});
	if (!analysis?.ok) return null;
	const summary = summarizeCommandSegmentsForDisplay(analysis.segments);
	const sanitizeText = params.sanitizeText;
	if (!sanitizeText) return summary;
	return {
		commandCount: summary.commandCount,
		nestedCommandCount: summary.nestedCommandCount,
		riskKinds: summary.riskKinds.map((kind) => sanitizeText(kind)),
		warningLines: summary.warningLines.map((line) => sanitizeText(line))
	};
}
//#endregion
//#region src/gateway/server-methods/exec-approval.ts
const APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS = { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" };
const RESERVED_PLUGIN_APPROVAL_ID_PREFIX = "plugin:";
function normalizeCommandSpans(spans, commandLength) {
	if (!spans) return;
	const candidates = spans.filter((span) => Number.isSafeInteger(span.startIndex) && Number.isSafeInteger(span.endIndex) && span.startIndex >= 0 && span.endIndex > span.startIndex && span.endIndex <= commandLength).toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
	const accepted = [];
	let cursor = 0;
	for (const span of candidates) {
		if (span.startIndex < cursor) continue;
		accepted.push({
			startIndex: span.startIndex,
			endIndex: span.endIndex
		});
		cursor = span.endIndex;
	}
	return accepted.length > 0 ? accepted : void 0;
}
function createExecApprovalHandlers(manager, opts) {
	return {
		"exec.approval.get": async ({ params, respond, client }) => {
			if (!validateExecApprovalGetParams(params)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid exec.approval.get params: ${formatValidationErrors(validateExecApprovalGetParams.errors)}`));
				return;
			}
			const resolved = resolvePendingApprovalRecord({
				manager,
				inputId: params.id,
				client,
				exposeAmbiguousPrefixError: true
			});
			if (!resolved.ok) {
				respondPendingApprovalLookupError({
					respond,
					response: resolved.response
				});
				return;
			}
			const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(resolved.snapshot.request);
			respond(true, {
				id: resolved.approvalId,
				commandText,
				commandPreview,
				allowedDecisions: resolveExecApprovalRequestAllowedDecisions(resolved.snapshot.request),
				host: resolved.snapshot.request.host ?? null,
				nodeId: resolved.snapshot.request.nodeId ?? null,
				agentId: resolved.snapshot.request.agentId ?? null,
				expiresAtMs: resolved.snapshot.expiresAtMs
			}, void 0);
		},
		"exec.approval.list": async ({ respond, client }) => {
			respond(true, manager.listPendingRecords().filter((record) => isApprovalRecordVisibleToClient({
				record,
				client
			})).map((record) => ({
				id: record.id,
				request: record.request,
				createdAtMs: record.createdAtMs,
				expiresAtMs: record.expiresAtMs
			})), void 0);
		},
		"exec.approval.request": async ({ params, respond, context, client }) => {
			if (!validateExecApprovalRequestParams(params)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid exec.approval.request params: ${formatValidationErrors(validateExecApprovalRequestParams.errors)}`));
				return;
			}
			const p = params;
			const twoPhase = p.twoPhase === true;
			const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
			const explicitId = normalizeOptionalString(p.id) ?? null;
			const host = normalizeOptionalString(p.host) ?? "";
			const nodeId = normalizeOptionalString(p.nodeId) ?? "";
			const approvalContext = resolveSystemRunApprovalRequestContext({
				host,
				command: p.command,
				commandArgv: p.commandArgv,
				systemRunPlan: p.systemRunPlan,
				cwd: p.cwd,
				agentId: p.agentId,
				sessionKey: p.sessionKey
			});
			const effectiveCommandArgv = approvalContext.commandArgv;
			const effectiveCwd = approvalContext.cwd;
			const effectiveAgentId = approvalContext.agentId;
			const effectiveSessionKey = approvalContext.sessionKey;
			const effectiveCommandText = approvalContext.commandText;
			if (host === "node" && !nodeId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId is required for host=node"));
				return;
			}
			if (host === "node" && !approvalContext.plan) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "systemRunPlan is required for host=node"));
				return;
			}
			if (effectiveCommandText.trim().length === 0) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
				return;
			}
			if (explicitId?.startsWith(RESERVED_PLUGIN_APPROVAL_ID_PREFIX)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `approval ids starting with ${RESERVED_PLUGIN_APPROVAL_ID_PREFIX} are reserved`));
				return;
			}
			if (host === "node" && (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "commandArgv is required for host=node"));
				return;
			}
			const envBinding = buildSystemRunApprovalEnvBinding(p.env);
			const warningText = normalizeOptionalString(p.warningText);
			const commandHighlighting = resolveExecCommandHighlighting({
				config: typeof context.getRuntimeConfig === "function" ? context.getRuntimeConfig() : {},
				agentId: effectiveAgentId
			});
			const sanitizedCommandDisplay = sanitizeExecApprovalDisplayTextWithStatus(effectiveCommandText);
			if (sanitizedCommandDisplay.truncated || sanitizedCommandDisplay.oversized) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "command exceeds exec approval display limit", { details: { reason: "EXEC_APPROVAL_COMMAND_DISPLAY_LIMIT" } }));
				return;
			}
			const sanitizedCommandText = sanitizedCommandDisplay.text;
			const commandAnalysis = resolveCommandAnalysisSummaryForDisplay({
				host,
				commandText: effectiveCommandText,
				commandArgv: effectiveCommandArgv,
				cwd: effectiveCwd,
				sanitizeText: sanitizeExecApprovalWarningText
			});
			const commandSpans = commandHighlighting && sanitizedCommandText === effectiveCommandText ? normalizeCommandSpans(p.commandSpans, sanitizedCommandText.length) : void 0;
			const systemRunBinding = host === "node" ? buildSystemRunApprovalBinding({
				argv: effectiveCommandArgv,
				cwd: effectiveCwd,
				agentId: effectiveAgentId,
				sessionKey: effectiveSessionKey,
				env: p.env
			}) : null;
			if (explicitId && manager.getSnapshot(explicitId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"));
				return;
			}
			const request = {
				command: sanitizedCommandText,
				commandPreview: host === "node" || !approvalContext.commandPreview ? void 0 : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
				commandArgv: host === "node" ? void 0 : effectiveCommandArgv,
				envKeys: envBinding.envKeys.length > 0 ? envBinding.envKeys : void 0,
				systemRunBinding: systemRunBinding?.binding ?? null,
				systemRunPlan: approvalContext.plan,
				cwd: effectiveCwd ?? null,
				nodeId: host === "node" ? nodeId : null,
				host: host || null,
				security: p.security ?? null,
				ask: p.ask ?? null,
				warningText: warningText ? sanitizeExecApprovalWarningText(warningText) : null,
				commandAnalysis,
				commandSpans,
				allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: p.ask ?? null }),
				agentId: effectiveAgentId ?? null,
				resolvedPath: p.resolvedPath ?? null,
				sessionKey: effectiveSessionKey ?? null,
				turnSourceChannel: normalizeOptionalString(p.turnSourceChannel) ?? null,
				turnSourceTo: normalizeOptionalString(p.turnSourceTo) ?? null,
				turnSourceAccountId: normalizeOptionalString(p.turnSourceAccountId) ?? null,
				turnSourceThreadId: p.turnSourceThreadId ?? null
			};
			const record = manager.create(request, timeoutMs, explicitId);
			record.requestedByConnId = client?.connId ?? null;
			record.requestedByDeviceId = client?.connect?.device?.id ?? null;
			record.requestedByClientId = client?.connect?.client?.id ?? null;
			record.requestedByDeviceTokenAuth = client?.isDeviceTokenAuth === true;
			let decisionPromise;
			try {
				decisionPromise = manager.register(record, timeoutMs);
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`));
				return;
			}
			const requestEvent = {
				id: record.id,
				request: record.request,
				createdAtMs: record.createdAtMs,
				expiresAtMs: record.expiresAtMs
			};
			await handlePendingApprovalRequest({
				manager,
				record,
				decisionPromise,
				respond,
				context,
				clientConnId: client?.connId,
				requestEventName: "exec.approval.requested",
				requestEvent,
				twoPhase,
				deliverRequest: () => {
					const deliveryTasks = [];
					if (opts?.forwarder) deliveryTasks.push(opts.forwarder.handleRequested(requestEvent).catch((err) => {
						context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
						return false;
					}));
					if (opts?.iosPushDelivery?.handleRequested) deliveryTasks.push(opts.iosPushDelivery.handleRequested(requestEvent, { isTargetVisible: (target) => isApprovalRecordVisibleToClient({
						record,
						client: { connect: {
							client: { id: GATEWAY_CLIENT_IDS.IOS_APP },
							device: { id: target.deviceId },
							scopes: [...target.scopes]
						} }
					}) }).catch((err) => {
						context.logGateway?.error?.(`exec approvals: iOS push request failed: ${String(err)}`);
						return false;
					}));
					if (deliveryTasks.length === 0) return false;
					return (async () => {
						let delivered = false;
						for (const task of deliveryTasks) delivered = await task || delivered;
						return delivered;
					})();
				},
				afterDecision: async (decision) => {
					if (decision === null) await opts?.iosPushDelivery?.handleExpired?.(requestEvent);
				},
				afterDecisionErrorLabel: "exec approvals: iOS push expire failed"
			});
		},
		"exec.approval.waitDecision": async ({ params, respond, client }) => {
			await handleApprovalWaitDecision({
				manager,
				inputId: params.id,
				client,
				respond
			});
		},
		"exec.approval.resolve": async ({ params, respond, client, context }) => {
			if (!validateExecApprovalResolveParams(params)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid exec.approval.resolve params: ${formatValidationErrors(validateExecApprovalResolveParams.errors)}`));
				return;
			}
			const p = params;
			if (!isApprovalDecision(p.decision)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
				return;
			}
			const decision = p.decision;
			await handleApprovalResolve({
				manager,
				inputId: p.id,
				decision,
				respond,
				context,
				client,
				exposeAmbiguousPrefixError: true,
				validateDecision: (snapshot) => {
					return resolveExecApprovalRequestAllowedDecisions(snapshot.request).includes(decision) ? null : {
						message: "allow-always is unavailable because the effective policy requires approval every time",
						details: APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS
					};
				},
				resolvedEventName: "exec.approval.resolved",
				buildResolvedEvent: ({ approvalId, decision, resolvedBy, snapshot, nowMs }) => ({
					id: approvalId,
					decision,
					resolvedBy,
					ts: nowMs,
					request: snapshot.request
				}),
				forwardResolved: (resolvedEvent) => opts?.forwarder?.handleResolved(resolvedEvent),
				forwardResolvedErrorLabel: "exec approvals: forward resolve failed",
				extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved ? [{
					run: (resolvedEvent) => opts.iosPushDelivery.handleResolved(resolvedEvent),
					errorLabel: "exec approvals: iOS push resolve failed"
				}] : void 0
			});
		}
	};
}
//#endregion
export { createExecApprovalHandlers };
