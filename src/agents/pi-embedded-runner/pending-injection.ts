/**
 * PR-15: pending-agent-injection consumer (runtime side).
 *
 * The gateway's `sessions.patch` handlers
 * (`src/gateway/sessions-patch.ts`) write a synthetic
 * `[QUESTION_ANSWER]: ...` or `[PLAN_DECISION]: ...` text into
 * `SessionEntry.pendingAgentInjection` whenever a `/plan answer`,
 * `/plan accept`, `/plan accept edits`, or `/plan revise` action
 * fires from any channel. This module is the consumer: it reads +
 * clears the field atomically so the injection is delivered once and
 * only once into the agent's next turn.
 *
 * Architecture:
 * - **Single source of truth**: every channel (web, Telegram, Discord,
 *   Slack, iMessage) goes through the gateway's `sessions.patch`
 *   handler, which writes the same `pendingAgentInjection` field. No
 *   per-channel direct-injection paths needed.
 * - **Consumed once**: `consumePendingAgentInjection` is the read +
 *   clear barrier. After it returns the value, the field is cleared on
 *   disk so a subsequent agent run won't double-inject.
 * - **Server-internal API**: this helper writes the SessionEntry
 *   directly via `updateSessionStoreEntry` (NOT through the public
 *   `sessions.patch` RPC) because the field is server-set and
 *   server-cleared — clients should never need to send it.
 */

import { loadConfig } from "../../config/io.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

export interface ConsumePendingAgentInjectionResult {
  /** The injection text that was cleared, or `undefined` if nothing was pending. */
  text: string | undefined;
}

/**
 * Atomically reads and clears `SessionEntry.pendingAgentInjection`.
 *
 * Returns the cleared value (or `undefined` if nothing was pending).
 * Best-effort — if the store write fails, returns the value that was
 * read so the caller can still inject; the field will be cleared on
 * the next successful write or remain set until then. The
 * once-and-only-once guarantee is honored on the happy path.
 */
export async function consumePendingAgentInjection(
  sessionKey: string,
  log?: { warn?: (msg: string) => void },
): Promise<ConsumePendingAgentInjectionResult> {
  if (!sessionKey || sessionKey.trim().length === 0) {
    return { text: undefined };
  }
  try {
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    let captured: string | undefined;
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        const current = entry.pendingAgentInjection;
        if (typeof current === "string" && current.length > 0) {
          captured = current;
          // Clear the field by deleting it from the entry. The store
          // serializer omits undefined fields, so `delete` is the
          // canonical way to remove it from disk.
          delete entry.pendingAgentInjection;
        }
        return entry;
      },
    });
    return { text: captured };
  } catch (err) {
    log?.warn?.(
      `consumePendingAgentInjection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { text: undefined };
  }
}

/**
 * Composes the agent's next-turn prompt by prepending a pending
 * injection (if any) to the user-supplied prompt. Used to render a
 * channel-agnostic synthetic message into the user-message context
 * without leaking the marker into chat history.
 *
 * Returns the original prompt unchanged when no injection is pending.
 */
export function composePromptWithPendingInjection(
  injectionText: string | undefined,
  userPrompt: string,
): string {
  if (!injectionText) {
    return userPrompt;
  }
  // Two newlines separate the injection from the user's actual input
  // so the agent sees them as distinct context blocks. If userPrompt
  // is empty (e.g., the answer/accept fired without a follow-up
  // message), the injection alone becomes the prompt.
  const trimmedUser = userPrompt.trim();
  if (trimmedUser.length === 0) {
    return injectionText;
  }
  return `${injectionText}\n\n${trimmedUser}`;
}
