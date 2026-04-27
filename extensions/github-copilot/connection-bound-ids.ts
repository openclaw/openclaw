import { createHash } from "node:crypto";

// Copilot's OpenAI-compatible `/responses` endpoint can emit replay item IDs
// that encode upstream connection state. Those IDs are rejected after the
// connection changes, so normalize them at the provider boundary before send.

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

type InputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

export function rewriteCopilotConnectionBoundResponseIds(input: unknown): boolean {
  if (!Array.isArray(input)) {
    return false;
  }
  let rewrote = false;
  for (const item of input as InputItem[]) {
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    // Reasoning AND function_call items reference server-side state bound to
    // the original item ID. Copilot validates the replayed ID against the
    // encrypted blob and rejects any rewrite, even when encrypted_content is
    // absent or null. Curl evidence in #72602 confirms `fc_<hash>` 400s the
    // same way `rs_<hash>` did before #71684 — sending the original opaque ID
    // (or omitting it) succeeds, the synthesised ID does not. Skip both types
    // unconditionally so Copilot's server-side lookup keeps working.
    if (item.type === "reasoning" || item.type === "function_call") {
      continue;
    }
    if (looksLikeConnectionBoundId(id)) {
      item.id = deriveReplacementId(typeof item.type === "string" ? item.type : undefined, id);
      rewrote = true;
    }
  }
  return rewrote;
}

export function rewriteCopilotResponsePayloadConnectionBoundIds(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return rewriteCopilotConnectionBoundResponseIds((payload as { input?: unknown }).input);
}
