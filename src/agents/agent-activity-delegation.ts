import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentActivityDelegation } from "../../packages/gateway-protocol/src/schema/logs-chat.js";

// Keep receipts inside the existing persisted result-detail budget.
const MAX_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 6_144;

function boundedString(value: unknown, max: number): string | undefined {
  const text = normalizeOptionalString(value);
  return text && text.length <= max ? text : undefined;
}

/** Only execution result fields are receipts; arguments and free-form output are not evidence. */
export function projectAgentActivityDelegation(
  name: string,
  result: unknown,
): AgentActivityDelegation[] | undefined {
  if (name !== "sessions_spawn" && name !== "agents_wait") {
    return undefined;
  }
  const envelope = asOptionalRecord(result);
  if (envelope?.isError === true) {
    return undefined;
  }
  const details = asOptionalRecord(envelope?.details);
  if (!details) {
    return undefined;
  }
  const recorded = Array.isArray(details.delegation) ? details.delegation : undefined;
  const persisted = recorded !== undefined;
  const candidates = recorded
    ? recorded
    : name === "sessions_spawn"
      ? details.status === "accepted"
        ? [details]
        : []
      : Array.isArray(details.completed)
        ? details.completed
        : [];
  const receipts: AgentActivityDelegation[] = [];
  let bytes = 2;
  for (const value of candidates.slice(0, MAX_RECEIPTS)) {
    const entry = asOptionalRecord(value);
    if (!entry) {
      continue;
    }
    const runId = boundedString(entry.runId, 256);
    const childSessionKey = boundedString(
      persisted || name === "sessions_spawn" ? entry.childSessionKey : entry.sessionKey,
      1024,
    );
    const status = entry.status;
    if (
      !runId ||
      !childSessionKey ||
      (status !== "accepted" &&
        status !== "done" &&
        status !== "failed" &&
        status !== "killed" &&
        status !== "timeout") ||
      (name === "sessions_spawn" ? status !== "accepted" : status === "accepted")
    ) {
      continue;
    }
    // Names and grouping are already retained in the individual accepted launch.
    const label = status === "accepted" ? boundedString(entry.label, 512) : undefined;
    const groupId = status === "accepted" ? boundedString(entry.groupId, 512) : undefined;
    const runtimeMs = entry.runtimeMs;
    const receipt: AgentActivityDelegation = {
      runId,
      childSessionKey,
      status,
      ...(label ? { label } : {}),
      ...(groupId ? { groupId } : {}),
      ...(status !== "accepted" &&
      typeof runtimeMs === "number" &&
      Number.isFinite(runtimeMs) &&
      runtimeMs >= 0 &&
      runtimeMs <= Number.MAX_SAFE_INTEGER
        ? { runtimeMs }
        : {}),
    };
    bytes += new TextEncoder().encode(JSON.stringify(receipt)).byteLength + 1;
    if (bytes > MAX_RECEIPT_BYTES) {
      break;
    }
    receipts.push(receipt);
  }
  return receipts.length ? receipts : undefined;
}
