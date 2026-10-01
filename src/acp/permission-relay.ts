import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { normalizeOptionalString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";

export type GatewayExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export type GatewayExecApprovalEvent = {
  approvalId: string;
  command?: string;
  host?: string;
  title?: string;
  toolCallId?: string;
};

export type GatewayExecApprovalDetails = {
  allowedDecisions?: unknown;
  commandPreview?: unknown;
  commandText?: unknown;
  host?: unknown;
};

const FALLBACK_EXEC_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;
const EXEC_APPROVAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function normalizeGatewayExecApprovalDecision(
  value: unknown,
): GatewayExecApprovalDecision | undefined {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return undefined;
}

function buildAcpPermissionOptions(value: unknown): PermissionOption[] {
  const normalized = Array.isArray(value)
    ? value.map(normalizeGatewayExecApprovalDecision).filter((decision) => decision !== undefined)
    : [];
  const decisions = new Set<string>(
    normalized.length > 0 ? normalized : FALLBACK_EXEC_APPROVAL_DECISIONS,
  );
  const options: PermissionOption[] = [];
  for (const option of EXEC_APPROVAL_OPTIONS) {
    if (decisions.has(option.optionId)) {
      options.push({ ...option });
    }
  }
  return options;
}

/** Parses legacy Gateway approval event data into ACP relay state. */
export function parseGatewayExecApprovalEventData(
  data: Record<string, unknown>,
): GatewayExecApprovalEvent | null {
  if (data.phase !== "requested" || data.kind !== "exec" || data.status !== "pending") {
    return null;
  }
  const approvalId = readNonEmptyString(data.approvalId);
  if (!approvalId) {
    return null;
  }
  return {
    approvalId,
    command: readNonEmptyString(data.command),
    host: readNonEmptyString(data.host),
    title: readNonEmptyString(data.title),
    toolCallId: readNonEmptyString(data.toolCallId),
  };
}

export function parseGatewayExecApprovalRequestEventPayload(
  payload: Record<string, unknown>,
): GatewayExecApprovalEvent | null {
  const approvalId = readNonEmptyString(payload.id);
  const request = payload.request;
  if (!approvalId || !request || typeof request !== "object" || Array.isArray(request)) {
    return null;
  }
  const requestRecord = request as Record<string, unknown>;
  return {
    approvalId,
    command:
      readNonEmptyString(requestRecord.command) ?? readNonEmptyString(requestRecord.commandPreview),
    host: readNonEmptyString(requestRecord.host),
    toolCallId: readNonEmptyString(requestRecord.toolCallId),
  };
}

export function buildAcpPermissionRequest(params: {
  sessionId: string;
  event: GatewayExecApprovalEvent;
  details?: GatewayExecApprovalDetails | null;
}): RequestPermissionRequest {
  const command =
    readNonEmptyString(params.details?.commandText) ??
    readNonEmptyString(params.details?.commandPreview) ??
    params.event.command;
  const host = readNonEmptyString(params.details?.host) ?? params.event.host;
  const rawInput: Record<string, string> = {
    name: "exec",
    approvalId: params.event.approvalId,
  };
  if (command) {
    rawInput.command = command;
  }
  if (host) {
    rawInput.host = host;
  }

  return {
    sessionId: params.sessionId,
    toolCall: {
      // Raw approval events can arrive before Gateway emits a tool call id; the
      // approval id remains the stable correlation key for those early prompts.
      toolCallId: params.event.toolCallId ?? `exec:${params.event.approvalId}`,
      title: params.event.title ?? "Command approval requested",
      kind: "execute",
      status: "pending",
      rawInput,
      _meta: {
        toolName: "exec",
        approvalId: params.event.approvalId,
      },
    },
    options: buildAcpPermissionOptions(params.details?.allowedDecisions),
  };
}

export function resolveGatewayDecisionFromPermissionOutcome(
  response: RequestPermissionResponse | undefined,
  options: readonly PermissionOption[],
): GatewayExecApprovalDecision | undefined {
  const outcome = response?.outcome;
  if (!outcome || outcome.outcome !== "selected") {
    return undefined;
  }
  const selected = options.find((option) => option.optionId === outcome.optionId);
  return normalizeGatewayExecApprovalDecision(selected?.optionId);
}
