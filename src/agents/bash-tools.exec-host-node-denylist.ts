import {
  buildExecDenylistRuleKey,
  evaluateExecDenylist,
  type ExecDenylistEntry,
  resolveEffectiveExecDenylist,
} from "../infra/exec-approvals-denylist.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import {
  type AllowAlwaysPersistenceDecision,
  type ExecApprovalsFile,
  type ExecCommandSegment,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";
import { callGatewayTool } from "./tools/gateway.js";

type NodeGatewayDenylistDispatchBinding = {
  approvedRuleKeys: readonly string[];
  screenings: readonly {
    command: string;
    segments: readonly ExecCommandSegment[];
    analysisOk: boolean;
  }[];
  resolveCurrentConfigDenylist?: () => readonly ExecDenylistEntry[];
  configDenylist: readonly ExecDenylistEntry[];
};

export type NodeGatewayDispatchAuthority =
  | "current-policy"
  | "human-approval"
  | "auto-review"
  | "ask-fallback";

export type NodeGatewayPolicyCheckpoint = {
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecSecurity;
};

export async function assertCurrentNodeGatewayPolicyAllowsDispatch(params: {
  request: ExecuteNodeHostCommandParams;
  authority: NodeGatewayDispatchAuthority;
  currentPolicyAllows?: (policy: { hostSecurity: ExecSecurity; hostAsk: ExecAsk }) => boolean;
  fallbackPolicy?: NodeGatewayPolicyCheckpoint;
  denylistBinding?: NodeGatewayDenylistDispatchBinding;
}): Promise<void> {
  assertCurrentNodeGatewayDenylistAllowsDispatch(params.denylistBinding);
  const current = await execHostShared.resolveExecHostApprovalContext({
    agentId: params.request.agentId,
    security: params.request.security,
    ask: params.request.ask,
    host: "node",
  });
  if (current.hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  if (params.authority === "human-approval") {
    return;
  }
  if (params.authority === "auto-review") {
    if (current.hostAsk === "always") {
      throw new Error("exec denied: host=node ask=always requires human approval");
    }
    return;
  }
  if (params.authority === "ask-fallback") {
    const expected = params.fallbackPolicy;
    if (
      !expected ||
      current.hostSecurity !== expected.hostSecurity ||
      current.hostAsk !== expected.hostAsk ||
      current.askFallback !== expected.askFallback
    ) {
      throw new Error("exec denied: host=node fallback policy changed before dispatch");
    }
    return;
  }
  if (!params.currentPolicyAllows?.(current)) {
    throw new Error("exec denied: host=node policy changed before dispatch");
  }
}

function assertCurrentNodeGatewayDenylistAllowsDispatch(
  binding: NodeGatewayDenylistDispatchBinding | undefined,
): void {
  if (!binding) {
    return;
  }
  const currentConfigDenylist = binding.resolveCurrentConfigDenylist?.() ?? binding.configDenylist;
  const currentEffective = resolveEffectiveExecDenylist({
    layers: [currentConfigDenylist],
  });
  const approvedRuleKeys = new Set(binding.approvedRuleKeys);
  const newlyCurrent = currentEffective.filter(
    (entry) => !approvedRuleKeys.has(buildExecDenylistRuleKey(entry)),
  );
  if (newlyCurrent.length === 0) {
    return;
  }
  for (const screening of binding.screenings) {
    const evaluation = evaluateExecDenylist({
      command: screening.command,
      segments: screening.segments,
      denylist: newlyCurrent,
      analysisOk: screening.analysisOk,
    });
    if (evaluation.match !== null || evaluation.conservativeApproval) {
      throw new Error("Exec approval changed before execution");
    }
  }
}

export function createOneShotAllowAlwaysDecision(): AllowAlwaysPersistenceDecision {
  return { kind: "one-shot", reasons: ["no-reusable-pattern"] };
}

async function fetchNodeApprovalsFileDenylist(params: {
  nodeId: string;
  agentId?: string;
}): Promise<ExecDenylistEntry[] | null> {
  try {
    const approvalsSnapshot = await callGatewayTool<{ file: unknown }>(
      "exec.approvals.node.get",
      { timeoutMs: 10_000 },
      { nodeId: params.nodeId },
    );
    if (!approvalsSnapshot || typeof approvalsSnapshot !== "object") {
      return null;
    }
    const approvalsFile = approvalsSnapshot.file;
    if (!approvalsFile || typeof approvalsFile !== "object") {
      return [];
    }
    const resolved = resolveExecApprovalsFromFile({
      file: approvalsFile as ExecApprovalsFile,
      agentId: params.agentId,
      overrides: { security: "full" },
    });
    return resolveEffectiveExecDenylist({ layers: [resolved.denylist] });
  } catch {
    return null;
  }
}

export async function resolveNodeFastPathDenylist(params: {
  nodeId: string;
  agentId?: string;
  execConfigDenylist?: readonly ExecDenylistEntry[];
  hostSecurity: string;
  hostAsk: string;
  strictInlineEval?: boolean;
}): Promise<{
  configDenylist: readonly ExecDenylistEntry[];
  fastPathApprovalsFileDenylist: ExecDenylistEntry[] | null;
  fastPathDenylistKnownEmpty: boolean;
}> {
  const configDenylist = resolveEffectiveExecDenylist({
    layers: [params.execConfigDenylist],
  });
  let fastPathApprovalsFileDenylist: ExecDenylistEntry[] | null = null;
  if (
    params.hostSecurity === "full" &&
    params.hostAsk === "off" &&
    params.strictInlineEval !== true &&
    configDenylist.length === 0
  ) {
    fastPathApprovalsFileDenylist = await fetchNodeApprovalsFileDenylist({
      nodeId: params.nodeId,
      agentId: params.agentId,
    });
  }
  return {
    configDenylist,
    fastPathApprovalsFileDenylist,
    fastPathDenylistKnownEmpty:
      configDenylist.length === 0 &&
      fastPathApprovalsFileDenylist !== null &&
      fastPathApprovalsFileDenylist.length === 0,
  };
}

export function buildNodeGatewayDenylistBinding(params: {
  preparedDenylist: readonly ExecDenylistEntry[];
  configDenylist: readonly ExecDenylistEntry[];
  denylistScreenings: NodeGatewayDenylistDispatchBinding["screenings"];
  resolveCurrentExecConfigDenylist?: () => readonly ExecDenylistEntry[];
}): NodeGatewayDenylistDispatchBinding {
  return {
    approvedRuleKeys: params.preparedDenylist.map(buildExecDenylistRuleKey),
    screenings: params.denylistScreenings,
    configDenylist: params.configDenylist,
    ...(params.resolveCurrentExecConfigDenylist
      ? { resolveCurrentConfigDenylist: params.resolveCurrentExecConfigDenylist }
      : {}),
  };
}
