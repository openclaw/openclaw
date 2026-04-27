import { loadExecApprovals, } from "../infra/exec-approvals.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { isRequestedExecTargetAllowed, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
function resolveExecConfigState(params) {
    const cfg = params.cfg ?? {};
    const resolvedAgentId = params.agentId ??
        resolveSessionAgentId({
            sessionKey: params.sessionKey,
            config: cfg,
        });
    const globalExec = cfg.tools?.exec;
    const agentExec = resolvedAgentId
        ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec
        : undefined;
    const host = params.sessionEntry?.execHost ??
        agentExec?.host ??
        globalExec?.host ??
        "auto";
    return {
        cfg,
        host,
        agentExec,
        globalExec,
    };
}
function resolveExecSandboxAvailability(params) {
    return (params.sandboxAvailable ??
        (params.sessionKey
            ? resolveSandboxRuntimeStatus({
                cfg: params.cfg,
                sessionKey: params.sessionKey,
            }).sandboxed
            : false));
}
export function canExecRequestNode(params) {
    const { cfg, host } = resolveExecConfigState(params);
    return isRequestedExecTargetAllowed({
        configuredTarget: host,
        requestedTarget: "node",
        sandboxAvailable: resolveExecSandboxAvailability({
            cfg,
            sessionKey: params.sessionKey,
            sandboxAvailable: params.sandboxAvailable,
        }),
    });
}
export function resolveExecDefaults(params) {
    const { cfg, host, agentExec, globalExec } = resolveExecConfigState(params);
    const sandboxAvailable = resolveExecSandboxAvailability({
        cfg,
        sessionKey: params.sessionKey,
        sandboxAvailable: params.sandboxAvailable,
    });
    const resolved = resolveExecTarget({
        configuredTarget: host,
        elevatedRequested: false,
        sandboxAvailable,
    });
    const approvalDefaults = loadExecApprovals().defaults;
    const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
    return {
        host,
        effectiveHost: resolved.effectiveHost,
        security: params.sessionEntry?.execSecurity ??
            agentExec?.security ??
            globalExec?.security ??
            approvalDefaults?.security ??
            defaultSecurity,
        ask: params.sessionEntry?.execAsk ??
            agentExec?.ask ??
            globalExec?.ask ??
            approvalDefaults?.ask ??
            "off",
        node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
        canRequestNode: isRequestedExecTargetAllowed({
            configuredTarget: host,
            requestedTarget: "node",
            sandboxAvailable,
        }),
    };
}
