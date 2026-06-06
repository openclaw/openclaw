import type { CommandQueueWaitInfo } from "../process/command-queue.types.js";

export const AGENT_SESSION_LANE_BUSY_CODE = "LANE_WAIT_EXCEEDED" as const;

export type AgentSessionLaneBusyDetails = {
  lane: string;
  waitedMs: number;
  warnAfterMs: number;
  queueAhead: number;
  activeAhead: number;
  activeNow: number;
  queueBehind: number;
};

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

export function normalizeAgentSessionLaneBusyDetails(
  value: unknown,
): AgentSessionLaneBusyDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const lane = typeof raw.lane === "string" && raw.lane.trim() ? raw.lane.trim() : undefined;
  const waitedMs = normalizeNonNegativeInteger(raw.waitedMs);
  const warnAfterMs = normalizeNonNegativeInteger(raw.warnAfterMs);
  const queueAhead = normalizeNonNegativeInteger(raw.queueAhead);
  const activeAhead = normalizeNonNegativeInteger(raw.activeAhead);
  const activeNow = normalizeNonNegativeInteger(raw.activeNow);
  const queueBehind = normalizeNonNegativeInteger(raw.queueBehind);
  if (
    !lane ||
    waitedMs === undefined ||
    warnAfterMs === undefined ||
    queueAhead === undefined ||
    activeAhead === undefined ||
    activeNow === undefined ||
    queueBehind === undefined
  ) {
    return undefined;
  }
  return {
    lane,
    waitedMs,
    warnAfterMs,
    queueAhead,
    activeAhead,
    activeNow,
    queueBehind,
  };
}

export function formatAgentSessionLaneBusyMessage(details: AgentSessionLaneBusyDetails): string {
  return (
    `Error: session lane busy (lane=${details.lane}, waitedMs=${details.waitedMs}ms, ` +
    `queueAhead=${details.queueAhead}, activeAhead=${details.activeAhead}, ` +
    `activeNow=${details.activeNow}, queueBehind=${details.queueBehind})\n` +
    "Suggestion: wait for the current task to complete and retry."
  );
}

export class AgentSessionLaneBusyError extends Error {
  readonly code = AGENT_SESSION_LANE_BUSY_CODE;
  readonly details: AgentSessionLaneBusyDetails;

  constructor(info: CommandQueueWaitInfo) {
    const details = normalizeAgentSessionLaneBusyDetails(info);
    if (!details) {
      throw new Error("invalid session lane busy details");
    }
    super(formatAgentSessionLaneBusyMessage(details));
    this.name = "AgentSessionLaneBusyError";
    this.details = details;
  }
}

export function isAgentSessionLaneBusyError(value: unknown): value is AgentSessionLaneBusyError {
  return (
    value instanceof Error &&
    value.name === "AgentSessionLaneBusyError" &&
    (value as { code?: unknown }).code === AGENT_SESSION_LANE_BUSY_CODE &&
    normalizeAgentSessionLaneBusyDetails((value as { details?: unknown }).details) !== undefined
  );
}
