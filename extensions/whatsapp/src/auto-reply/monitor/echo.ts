// Whatsapp plugin module implements echo behavior.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
export type EchoTracker = {
  rememberText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
      /** WhatsApp JID of the conversation this text was sent to. */
      conversationId?: string;
    },
  ) => void;
  has: (key: string, conversationId?: string) => boolean;
  forget: (key: string, conversationId?: string) => void;
  buildCombinedKey: (params: { sessionKey: string; combinedBody: string }) => string;
};

export function createEchoTracker(params: {
  maxItems?: number;
  logVerbose?: (msg: string) => void;
}): EchoTracker {
  const recentlySent = new Set<string>();
  const maxItems = Math.max(1, params.maxItems ?? 100);

  const buildCombinedKey = (p: { sessionKey: string; combinedBody: string }) =>
    `combined:${p.sessionKey}:${p.combinedBody}`;

  const trim = () => {
    while (recentlySent.size > maxItems) {
      const firstKey = recentlySent.values().next().value;
      if (!firstKey) {
        break;
      }
      recentlySent.delete(firstKey);
    }
  };

  const scopedKey = (key: string, conversationId?: string) =>
    conversationId ? `${conversationId}\0${key}` : key;

  const rememberText: EchoTracker["rememberText"] = (text, opts) => {
    if (!text) {
      return;
    }
    const key = scopedKey(text, opts.conversationId);
    recentlySent.add(key);
    if (opts.combinedBody && opts.combinedBodySessionKey) {
      recentlySent.add(
        buildCombinedKey({
          sessionKey: opts.combinedBodySessionKey,
          combinedBody: opts.combinedBody,
        }),
      );
    }
    if (opts.logVerboseMessage) {
      params.logVerbose?.(
        `Added to echo detection set (size now: ${recentlySent.size}): ${truncateUtf16Safe(text, 50)}...`,
      );
    }
    trim();
  };

  return {
    rememberText,
    has: (key, conversationId) => recentlySent.has(scopedKey(key, conversationId)),
    forget: (key, conversationId) => {
      recentlySent.delete(scopedKey(key, conversationId));
    },
    buildCombinedKey,
  };
}
