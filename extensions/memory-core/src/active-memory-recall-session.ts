/**
 * Active Memory's blocking recall runs. Each run is a sub-agent session with id
 * `active-memory-<base36 time>-<8 hex>` and, when it has a parent, key `<parent>:active-memory:<12 hex>`.
 * Their transcripts are the recall prompt, not a conversation.
 */
const RECALL_SESSION_ID = /^active-memory-[a-z0-9]+-[a-f0-9]{8}$/i;
const RECALL_SESSION_KEY = /:active-memory:[a-f0-9]{12}$/i;

export function isActiveMemoryRecallSessionKey(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey && RECALL_SESSION_KEY.test(sessionKey.trim()));
}

export function isActiveMemoryRecallSession(params: {
  sessionId?: string;
  sessionKey?: string;
  pluginOwnerId?: string;
}): boolean {
  // Transcript artifacts that are not in the session store reach the indexer without a key, so
  // the id is checked too.
  return (
    params.pluginOwnerId === "active-memory" ||
    isActiveMemoryRecallSessionKey(params.sessionKey) ||
    Boolean(params.sessionId && RECALL_SESSION_ID.test(params.sessionId))
  );
}
