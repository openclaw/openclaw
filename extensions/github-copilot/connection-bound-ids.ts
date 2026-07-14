// Github Copilot plugin module implements connection-bound replay sanitation.
import { createHash } from "node:crypto";

type InputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

export type CopilotReasoningFingerprintCounts = ReadonlyMap<string, number>;

export type CopilotReplaySanitizeResult = {
  changed: boolean;
  reasoningFingerprints: Map<string, number>;
};

function isInputItem(value: unknown): value is InputItem {
  return Boolean(value) && typeof value === "object";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isUserMessage(item: unknown): boolean {
  return isInputItem(item) && item.type === "message" && item.role === "user";
}

function isAssistantMessage(item: unknown): item is InputItem {
  return isInputItem(item) && item.type === "message" && item.role === "assistant";
}

function isFunctionCallOutput(item: unknown): item is InputItem {
  return isInputItem(item) && item.type === "function_call_output";
}

function looksLikeConnectionBoundId(id: string): boolean {
  if (id.length < 24) {
    return false;
  }
  if (/^(?:rs|msg|fc)_[A-Za-z0-9_-]+$/.test(id)) {
    return false;
  }
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(id)) {
    return false;
  }
  return Buffer.from(id, "base64").length >= 16;
}

function deriveReplacementId(type: string | undefined, originalId: string): string {
  const prefix = type === "function_call" ? "fc" : "msg";
  const hex = createHash("sha256").update(originalId).digest("hex").slice(0, 16);
  return `${prefix}_${hex}`;
}

function resolveLatestAssistantRound(input: unknown[]): { start: number; end: number } | undefined {
  let outputStart = input.length;
  while (outputStart > 0 && isFunctionCallOutput(input[outputStart - 1])) {
    outputStart -= 1;
  }
  if (outputStart === input.length) {
    return undefined;
  }

  let boundary = outputStart - 1;
  while (boundary >= 0) {
    const item = input[boundary];
    if (isUserMessage(item) || isFunctionCallOutput(item)) {
      break;
    }
    boundary -= 1;
  }
  if (boundary < 0 || !input.slice(0, boundary + 1).some(isUserMessage)) {
    return undefined;
  }

  const calls = new Set<string>();
  for (let index = boundary + 1; index < outputStart; index += 1) {
    const item = input[index];
    if (!isInputItem(item) || item.type !== "function_call") {
      continue;
    }
    const callId = readNonEmptyString(item.call_id);
    if (!callId || calls.has(callId)) {
      return undefined;
    }
    calls.add(callId);
  }
  if (calls.size === 0) {
    return undefined;
  }

  const outputs = new Set<string>();
  for (let index = outputStart; index < input.length; index += 1) {
    const item = input[index];
    const callId = isInputItem(item) ? readNonEmptyString(item.call_id) : undefined;
    if (!callId || outputs.has(callId) || !calls.has(callId)) {
      return undefined;
    }
    outputs.add(callId);
  }
  if (outputs.size !== calls.size) {
    return undefined;
  }
  return { start: boundary + 1, end: outputStart };
}

function normalizeCopilotReasoningId(item: InputItem): boolean {
  const id = item.id;
  if (id === undefined) {
    return true;
  }
  if (typeof id !== "string" || id.length === 0) {
    return false;
  }
  if (/^rs_[A-Za-z0-9_-]+$/.test(id)) {
    return true;
  }
  if (looksLikeConnectionBoundId(id)) {
    delete item.id;
    return true;
  }
  return false;
}

function fingerprintReasoning(item: InputItem): string {
  return createHash("sha256")
    .update(typeof item.id === "string" ? item.id : "")
    .update("\0")
    .update(item.encrypted_content as string)
    .digest("hex");
}

function stripPairedAssistantMessageIds(input: unknown[], droppedReasoning: Set<number>): boolean {
  let changed = false;
  for (const droppedIndex of droppedReasoning) {
    let nextIndex = droppedIndex + 1;
    while (droppedReasoning.has(nextIndex)) {
      nextIndex += 1;
    }
    const next = input[nextIndex];
    if (isAssistantMessage(next) && "id" in next) {
      delete next.id;
      changed = true;
    }
  }
  return changed;
}

export function sanitizeCopilotReplayResponseItems(
  input: unknown,
  approvedReasoning?: CopilotReasoningFingerprintCounts,
): CopilotReplaySanitizeResult {
  if (!Array.isArray(input)) {
    return { changed: false, reasoningFingerprints: new Map() };
  }

  const round = resolveLatestAssistantRound(input);
  const remainingApprovals =
    approvedReasoning === undefined ? undefined : new Map(approvedReasoning);
  const retainedFingerprints = new Map<string, number>();
  const droppedReasoning = new Set<number>();
  let changed = false;

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isInputItem(item) || item.type !== "reasoning") {
      continue;
    }
    const encryptedContent = readNonEmptyString(item.encrypted_content);
    const inRound = round !== undefined && index >= round.start && index < round.end;
    const originalId = item.id;
    if (!inRound || !encryptedContent || !normalizeCopilotReasoningId(item)) {
      droppedReasoning.add(index);
      changed = true;
      continue;
    }
    if (originalId !== undefined && item.id === undefined) {
      changed = true;
    }
    const fingerprint = fingerprintReasoning(item);
    if (remainingApprovals) {
      const approvals = remainingApprovals.get(fingerprint);
      if (!approvals || approvals < 1) {
        droppedReasoning.add(index);
        changed = true;
        continue;
      }
      remainingApprovals.set(fingerprint, approvals - 1);
    }
    retainedFingerprints.set(fingerprint, (retainedFingerprints.get(fingerprint) ?? 0) + 1);
  }

  changed = stripPairedAssistantMessageIds(input, droppedReasoning) || changed;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (droppedReasoning.has(index)) {
      input.splice(index, 1);
      continue;
    }
    const item = input[index];
    if (!isInputItem(item) || item.type === "reasoning") {
      continue;
    }
    const id = item.id;
    if (typeof id === "string" && id.length > 0 && looksLikeConnectionBoundId(id)) {
      item.id = deriveReplacementId(typeof item.type === "string" ? item.type : undefined, id);
      changed = true;
    }
  }

  return { changed, reasoningFingerprints: retainedFingerprints };
}

export function sanitizeCopilotResponsePayload(
  payload: unknown,
  approvedReasoning?: CopilotReasoningFingerprintCounts,
): CopilotReplaySanitizeResult {
  if (!payload || typeof payload !== "object") {
    return { changed: false, reasoningFingerprints: new Map() };
  }
  return sanitizeCopilotReplayResponseItems(
    (payload as { input?: unknown }).input,
    approvedReasoning,
  );
}
