import { DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS, } from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";
function buildExecApprovalRequestToolParams(params) {
    return {
        id: params.id,
        command: params.command,
        commandArgv: params.commandArgv,
        systemRunPlan: params.systemRunPlan,
        env: params.env,
        cwd: params.cwd,
        nodeId: params.nodeId,
        host: params.host,
        security: params.security,
        ask: params.ask,
        agentId: params.agentId,
        resolvedPath: params.resolvedPath,
        sessionKey: params.sessionKey,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
    };
}
function parseDecision(value) {
    if (!value || typeof value !== "object") {
        return { present: false, value: null };
    }
    // Distinguish "field missing" from "field present but null/invalid".
    // Registration responses intentionally omit `decision`; decision waits can include it.
    if (!Object.hasOwn(value, "decision")) {
        return { present: false, value: null };
    }
    const decision = value.decision;
    return { present: true, value: typeof decision === "string" ? decision : null };
}
function parseString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function parseExpiresAtMs(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export async function registerExecApprovalRequest(params) {
    // Two-phase registration is critical: the ID must be registered server-side
    // before exec returns `approval-pending`, otherwise `/approve` can race and orphan.
    const registrationResult = await callGatewayTool("exec.approval.request", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, buildExecApprovalRequestToolParams(params), { expectFinal: false });
    const decision = parseDecision(registrationResult);
    const id = parseString(registrationResult?.id) ?? params.id;
    const expiresAtMs = parseExpiresAtMs(registrationResult?.expiresAtMs) ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    if (decision.present) {
        return { id, expiresAtMs, finalDecision: decision.value };
    }
    return { id, expiresAtMs };
}
export async function waitForExecApprovalDecision(id) {
    try {
        const decisionResult = await callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id });
        return parseDecision(decisionResult).value;
    }
    catch (err) {
        // Timeout/cleanup path: treat missing/expired as no decision so askFallback applies.
        const message = String(err).toLowerCase();
        if (message.includes("approval expired or not found")) {
            return null;
        }
        throw err;
    }
}
export async function resolveRegisteredExecApprovalDecision(params) {
    if (params.preResolvedDecision !== undefined) {
        return params.preResolvedDecision ?? null;
    }
    return await waitForExecApprovalDecision(params.approvalId);
}
export async function requestExecApprovalDecision(params) {
    const registration = await registerExecApprovalRequest(params);
    if (Object.hasOwn(registration, "finalDecision")) {
        return registration.finalDecision ?? null;
    }
    return await waitForExecApprovalDecision(registration.id);
}
export function buildExecApprovalRequesterContext(params) {
    return {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
    };
}
export function buildExecApprovalTurnSourceContext(params) {
    return {
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
    };
}
function buildHostApprovalDecisionParams(params) {
    return {
        id: params.approvalId,
        command: params.command,
        commandArgv: params.commandArgv,
        systemRunPlan: params.systemRunPlan,
        env: params.env,
        cwd: params.workdir,
        nodeId: params.nodeId,
        host: params.host,
        security: params.security,
        ask: params.ask,
        ...buildExecApprovalRequesterContext({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
        }),
        resolvedPath: params.resolvedPath,
        ...buildExecApprovalTurnSourceContext(params),
    };
}
export async function requestExecApprovalDecisionForHost(params) {
    return await requestExecApprovalDecision(buildHostApprovalDecisionParams(params));
}
export async function registerExecApprovalRequestForHost(params) {
    return await registerExecApprovalRequest(buildHostApprovalDecisionParams(params));
}
export async function registerExecApprovalRequestForHostOrThrow(params) {
    try {
        return await registerExecApprovalRequestForHost(params);
    }
    catch (err) {
        throw new Error(`Exec approval registration failed: ${String(err)}`, { cause: err });
    }
}
