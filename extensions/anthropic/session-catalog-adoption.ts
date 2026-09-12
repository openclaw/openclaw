import { createHash } from "node:crypto";

export const CLAUDE_LOCAL_SESSION_HOST_ID = "gateway:local";
const CLAUDE_ADOPTED_SESSION_KEY_PREFIX = "plugin:anthropic:catalog-adopt:claude:";
const AGENT_SCOPED_KEY_PREFIX = "agent:";

export function adoptedSourceKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

export function adoptedSessionKey(hostId: string, threadId: string): string {
  // Local rows hash threadId alone: adopted keys minted before node support
  // must stay stable, or existing adopted sessions would orphan/duplicate.
  const source =
    hostId === CLAUDE_LOCAL_SESSION_HOST_ID ? threadId : adoptedSourceKey(hostId, threadId);
  return `${CLAUDE_ADOPTED_SESSION_KEY_PREFIX}${createHash("sha256").update(source).digest("hex")}`;
}

/** True for session keys minted by the catalog adoption flow (see adoptedSessionKey). */
export function isClaudeAdoptedSessionKey(sessionKey: string | undefined): boolean {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return false;
  }
  // Session creation persists the minted key agent-scoped
  // (`agent:<agentId>:<minted>`); agent ids never contain colons, so stripping
  // one scope restores the minted shape. Bound-session enumeration returns that
  // persisted key, and the projector must keep recognizing adopted rows while
  // every other binding stays unprojected.
  let minted = sessionKey;
  if (sessionKey.startsWith(AGENT_SCOPED_KEY_PREFIX)) {
    const separator = sessionKey.indexOf(":", AGENT_SCOPED_KEY_PREFIX.length);
    if (separator < 0) {
      return false;
    }
    minted = sessionKey.slice(separator + 1);
  }
  return minted.startsWith(CLAUDE_ADOPTED_SESSION_KEY_PREFIX);
}
