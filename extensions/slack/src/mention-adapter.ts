import type { ChannelMentionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeSlackStableEntry } from "./monitor/ingress-identity.js";

/** The retained ID/name form is for model input; these ranges only describe display. */
function readSlackDisplayMentions(text: string) {
  return Array.from(text.matchAll(/<@([UW][A-Z0-9]+)>(?: \(([^\r\n)]{1,256})\))?/gu)).flatMap(
    (match) => {
      const userId = match[1];
      const senderId = userId ? normalizeSlackStableEntry(userId) : null;
      return senderId
        ? [
            {
              start: match.index,
              end: match.index + match[0].length,
              senderId,
              ...(match[2]?.trim() ? { fallbackLabel: match[2].trim() } : {}),
            },
          ]
        : [];
    },
  );
}

export const slackMentionAdapter: ChannelMentionAdapter = {
  readDisplayMentions: readSlackDisplayMentions,
  stripPatterns: ({ ctx }) => {
    const preparedPatterns = ctx.ChannelContext?.chat?.mentionStripPatterns;
    const exactPatterns = Array.isArray(preparedPatterns)
      ? preparedPatterns.flatMap((pattern) =>
          typeof pattern === "string" ? [escapeRegExp(pattern)] : [],
        )
      : [];
    return [...exactPatterns, "<@[^>\\s]+>"];
  },
};
