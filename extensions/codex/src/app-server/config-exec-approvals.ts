import {
  execPolicy,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import type {
  OpenClawExecApprovalFloorsForCodexAppServer,
  OpenClawExecMode,
  OpenClawExecPolicyForCodexAppServer,
} from "./config-contracts.js";
import { readExecAsk, readExecSecurity, readRecord } from "./config-utils.js";

export function resolveOpenClawExecPolicyForCodexAppServer(params: {
  permissionMode?: EmbeddedRunAttemptParamsV2["permissionMode"];
  execOverrides?: {
    mode?: unknown;
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: OpenClawConfig;
  agentId?: string;
}): OpenClawExecPolicyForCodexAppServer {
  if (params.permissionMode === "full") {
    return resolveOpenClawExecPolicy({ mode: "full" });
  }
  const globalExec = readRecord(params.config?.tools?.exec);
  const globalPolicy = applyOpenClawExecPolicyLayer(
    resolveOpenClawExecPolicy({ mode: "full" }, false),
    globalExec,
  );
  const agentId = params.agentId?.trim();
  const agentExec = agentId
    ? readRecord(resolveAgentConfig(params.config ?? {}, agentId)?.tools?.exec)
    : undefined;
  const basePolicy = applyOpenClawExecPolicyLayer(globalPolicy, agentExec);
  const overridePolicy = applyOpenClawExecPolicyLayer(basePolicy, params.execOverrides);
  const approvalFloors = params.approvals
    ? resolveExecApprovalsFromFile({
        file: params.approvals,
        agentId: params.agentId,
        overrides: { security: overridePolicy.security, ask: overridePolicy.ask },
      }).agent
    : undefined;
  if (!approvalFloors) {
    return overridePolicy;
  }
  const nextSecurity = approvalFloors.security
    ? execPolicy.minSecurity(overridePolicy.security, approvalFloors.security)
    : overridePolicy.security;
  const nextAsk = approvalFloors.ask
    ? execPolicy.maxAsk(overridePolicy.ask, approvalFloors.ask)
    : overridePolicy.ask;
  if (nextSecurity === overridePolicy.security && nextAsk === overridePolicy.ask) {
    return overridePolicy;
  }
  return resolveOpenClawExecPolicy({ security: nextSecurity, ask: nextAsk });
}

function applyOpenClawExecPolicyLayer(
  base: OpenClawExecPolicyForCodexAppServer,
  exec?: { mode?: unknown; security?: unknown; ask?: unknown },
): OpenClawExecPolicyForCodexAppServer {
  if (!exec) {
    return base;
  }
  const mode = readExecMode(exec.mode);
  if (mode !== undefined) {
    return resolveOpenClawExecPolicy({ mode });
  }
  const security = readExecSecurity(exec.security);
  const ask = readExecAsk(exec.ask);
  if (security === undefined && ask === undefined) {
    return base;
  }
  return resolveOpenClawExecPolicy({ security: security ?? base.security, ask: ask ?? base.ask });
}

function resolveOpenClawExecPolicy(
  policy: OpenClawExecApprovalFloorsForCodexAppServer & { mode?: OpenClawExecMode },
  touched = true,
): OpenClawExecPolicyForCodexAppServer {
  const { mode, security, ask } = execPolicy.resolveExecModePolicy({
    mode: policy.mode,
    security: policy.security ?? "full",
    ask: policy.ask ?? "off",
  });
  return { mode, security, ask, touched };
}

function readExecMode(value: unknown): OpenClawExecMode | undefined {
  return value === "deny" ||
    value === "allowlist" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
    ? value
    : undefined;
}
