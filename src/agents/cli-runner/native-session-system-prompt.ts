// The system prompt a native CLI session last received, so a later native control
// operation (manual compaction) on that session sends the same prefix and reads the
// provider cache instead of rewriting it. Turns build their prompt from reply-pipeline
// inputs (inbound metadata, vision, delivery mode) a control operation does not have.
// Process memory only: after a Gateway restart compaction falls back to a rebuilt prompt,
// which can miss the cache once. Native session ids are unique per session, so the id is
// the whole identity of the answer.
const MAX_REMEMBERED_SESSIONS = 256;
const remembered = new Map<string, string>();

const key = (backendId: string, nativeSessionId: string) => `${backendId}\0${nativeSessionId}`;

export function rememberNativeSessionSystemPrompt(
  backendId: string,
  nativeSessionId: string,
  systemPrompt: string,
): void {
  const entry = key(backendId, nativeSessionId);
  remembered.delete(entry);
  remembered.set(entry, systemPrompt);
  if (remembered.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) {
      remembered.delete(oldest);
    }
  }
}

export function recallNativeSessionSystemPrompt(
  backendId: string,
  nativeSessionId: string,
): string | undefined {
  return remembered.get(key(backendId, nativeSessionId));
}
