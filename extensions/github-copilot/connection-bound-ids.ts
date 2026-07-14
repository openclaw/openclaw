// Github Copilot plugin module implements connection-bound replay sanitation.
import { createHash } from "node:crypto";

type InputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

function isInputItem(value: unknown): value is InputItem {
  return Boolean(value) && typeof value === "object";
}

function isAssistantMessage(item: unknown): item is InputItem {
  return isInputItem(item) && item.type === "message" && item.role === "assistant";
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

function isValidReasoningReplayId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 64;
}

function isValidNativeReasoningReplayId(id: unknown): id is string {
  return isValidReasoningReplayId(id) && /^rs_[A-Za-z0-9_-]+$/.test(id);
}

function normalizeCopilotReasoningId(item: InputItem): boolean {
  const id = item.id;
  if (id === undefined) {
    return true;
  }
  if (typeof id !== "string" || id.length === 0) {
    return false;
  }
  if (isValidNativeReasoningReplayId(id)) {
    return true;
  }
  if (looksLikeConnectionBoundId(id)) {
    delete item.id;
    return true;
  }
  return false;
}

function sanitizeCopilotEncryptedReasoning(input: unknown[]): boolean {
  let changed = false;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isInputItem(item) || item.type !== "reasoning") {
      continue;
    }
    const originalId = item.id;
    if (
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content.length === 0 ||
      !normalizeCopilotReasoningId(item)
    ) {
      input.splice(index, 1);
      const next = input[index];
      if (isAssistantMessage(next) && "id" in next) {
        // Signed message ids are replayable only with their preceding reasoning item.
        delete next.id;
      }
      changed = true;
      continue;
    }
    changed ||= originalId !== undefined && item.id === undefined;
  }
  return changed;
}

export function sanitizeCopilotReplayResponseIds(input: unknown): boolean {
  if (!Array.isArray(input)) {
    return false;
  }
  let changed = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isInputItem(item)) {
      continue;
    }
    const id = item.id;
    if (item.type === "reasoning") {
      if (id !== undefined && !isValidReasoningReplayId(id)) {
        input.splice(index, 1);
        changed = true;
      }
      continue;
    }
    if (typeof id === "string" && id.length > 0 && looksLikeConnectionBoundId(id)) {
      item.id = deriveReplacementId(typeof item.type === "string" ? item.type : undefined, id);
      changed = true;
    }
  }
  return changed;
}

export function rewriteCopilotConnectionBoundResponseIds(input: unknown): boolean {
  return sanitizeCopilotReplayResponseIds(input);
}

export function rewriteCopilotResponsePayloadConnectionBoundIds(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const input = (payload as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    return false;
  }
  const reasoningChanged = sanitizeCopilotEncryptedReasoning(input);
  return sanitizeCopilotReplayResponseIds(input) || reasoningChanged;
}
