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
    if (looksLikeConnectionBoundId(id)) {
      // Copilot accepts replayed connection-bound response items when the id is
      // omitted and recovers the real id from encrypted_content/server state.
      // Synthesizing rs_/fc_/msg_ ids with hashes creates values Copilot never
      // issued, so encrypted_content validation can fail with "item_id did not
      // match the target item id" on multi-turn tool-call replays.
      delete item.id;
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
