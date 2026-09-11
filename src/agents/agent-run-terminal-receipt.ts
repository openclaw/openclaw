import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";

type AgentRunTerminalModelRef = { provider: string; model: string };

export type AgentRunAcceptedDelegationReceipt = {
  runId: string;
  childSessionKey: string;
  completionWatch: boolean;
};

export type AgentRunApprovalReceipt = {
  approvalId: string;
  toolCallId?: string;
  state: "waiting" | "resolved";
};

const AGENT_RUN_ROUTE_CHANGE_MAX_CHARS = 320;
export const AGENT_RUN_TERMINAL_LINK_MAX_ITEMS = 20;

export type AgentRunTerminalReceipt = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  acceptedDelegations?: AgentRunAcceptedDelegationReceipt[];
  approvalReceipts?: AgentRunApprovalReceipt[];
  /** A final reply was delivered to the external source conversation. */
  sourceReplyDelivered?: true;
  rerouted: boolean;
  terminalDisposition: "visible" | "not-visible";
};

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function normalizeModelRef(value: unknown): AgentRunTerminalModelRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = boundedString(record.provider, 128);
  const model = boundedString(record.model, 256);
  return provider && model ? { provider, model } : undefined;
}

function normalizeSuccessfulToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [
    ...new Set(
      value
        .slice(0, AGENT_RUN_TERMINAL_LINK_MAX_ITEMS)
        .map((entry) => boundedString(entry, 128))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

export function normalizeAgentRunAcceptedDelegationReceipts(
  value: unknown,
): AgentRunAcceptedDelegationReceipt[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .slice(0, AGENT_RUN_TERMINAL_LINK_MAX_ITEMS)
    .flatMap((entry): AgentRunAcceptedDelegationReceipt[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const record = entry as Record<string, unknown>;
      const runId = boundedString(record.runId, 256);
      const childSessionKey = boundedString(record.childSessionKey, 1_024);
      if (!runId || !childSessionKey || typeof record.completionWatch !== "boolean") {
        return [];
      }
      return [{ runId, childSessionKey, completionWatch: record.completionWatch }];
    });
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeAgentRunApprovalReceipts(
  value: unknown,
): AgentRunApprovalReceipt[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const byApprovalId = new Map<string, AgentRunApprovalReceipt>();
  for (const entry of value) {
    if (byApprovalId.size >= AGENT_RUN_TERMINAL_LINK_MAX_ITEMS) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const approvalId = boundedString(record.approvalId, 256);
    const toolCallId = boundedString(record.toolCallId, 256);
    const state = record.state;
    if (!approvalId || (state !== "waiting" && state !== "resolved")) {
      continue;
    }
    const previous = byApprovalId.get(approvalId);
    byApprovalId.set(approvalId, {
      approvalId,
      ...(toolCallId
        ? { toolCallId }
        : previous?.toolCallId
          ? { toolCallId: previous.toolCallId }
          : {}),
      state: previous?.state === "resolved" || state === "resolved" ? "resolved" : "waiting",
    });
  }
  const normalized = Array.from(byApprovalId.values());
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const receipt = value as Record<string, unknown>;
  const runId = boundedString(receipt.runId, 256);
  const sessionId = boundedString(receipt.sessionId, 256);
  const turnId = boundedString(receipt.turnId, 256);
  const requested = normalizeModelRef(receipt.requested);
  const effectiveBase = normalizeModelRef(receipt.effective);
  const effectiveRecord = receipt.effective as Record<string, unknown> | undefined;
  const responseModel = boundedString(effectiveRecord?.responseModel, 256);
  const successfulToolNames = normalizeSuccessfulToolNames(receipt.successfulToolNames);
  const terminalDisposition = receipt.terminalDisposition;
  if (
    !runId ||
    !sessionId ||
    !turnId ||
    !requested ||
    !effectiveBase ||
    !responseModel ||
    !successfulToolNames ||
    typeof receipt.rerouted !== "boolean" ||
    (terminalDisposition !== "visible" && terminalDisposition !== "not-visible")
  ) {
    return undefined;
  }
  const acceptedDelegations = normalizeAgentRunAcceptedDelegationReceipts(
    receipt.acceptedDelegations,
  );
  const approvalReceipts = normalizeAgentRunApprovalReceipts(receipt.approvalReceipts);
  return {
    runId,
    sessionId,
    turnId,
    requested,
    effective: { ...effectiveBase, responseModel },
    successfulToolNames,
    ...(acceptedDelegations ? { acceptedDelegations } : {}),
    ...(approvalReceipts ? { approvalReceipts } : {}),
    ...(receipt.sourceReplyDelivered === true ? { sourceReplyDelivered: true } : {}),
    rerouted: receipt.rerouted,
    terminalDisposition,
  };
}

function formatAgentRunModelRef(value: AgentRunTerminalModelRef): string | undefined {
  const route = redactSensitiveText(`${value.provider}/${value.model}`, { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return route ? truncateUtf16Safe(route, 128) : undefined;
}

/** Normalizes the producer-owned route fact before lifecycle or prompt use. */
export function normalizeAgentRunRouteChange(value: unknown): string | undefined {
  const normalized =
    typeof value === "string"
      ? redactSensitiveText(value, { mode: "tools" }).replace(/\s+/gu, " ").trim()
      : "";
  return normalized ? truncateUtf16Safe(normalized, AGENT_RUN_ROUTE_CHANGE_MAX_CHARS) : undefined;
}

/** Formats the bounded, secret-free route fact owned by a terminal receipt. */
export function formatAgentRunRouteChange(
  receipt: AgentRunTerminalReceipt | undefined,
  expectedRunId: string,
): string | undefined {
  if (
    receipt?.runId !== expectedRunId ||
    !receipt.rerouted ||
    receipt.terminalDisposition !== "visible"
  ) {
    return undefined;
  }
  const requested = formatAgentRunModelRef(receipt.requested);
  const effective = formatAgentRunModelRef({
    ...receipt.effective,
    model: receipt.effective.responseModel || receipt.effective.model,
  });
  return requested && effective ? `Model route changed: ${requested} → ${effective}.` : undefined;
}
