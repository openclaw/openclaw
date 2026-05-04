/**
 * Phase 1B.1+ outbound adapter.
 *
 * `sendText` issues `POST /messages?chat_id=<n>` against MAX through the same
 * polling-http wrapper the supervisor uses (per docs/max-plugin/plan.md
 * §6.1.6: the wrapper is reused for non-polling MAX API calls). This gives
 * outbound the same `Retry-After` honoring, per-request timeout, and 401
 * classification as polling.
 *
 * `sendMedia` / `sendPoll` still throw — attachments and polls land in
 * Phase 4 / future phases.
 */

import { MAX_TEXT_CHUNK_LIMIT } from "../constants.js";
import { sendMaxText } from "../send.js";
import type { CoreConfig } from "../types.js";

const NOT_IMPLEMENTED_PHASE_1B = "not implemented in Phase 1B";

export const maxMessengerOutboundAdapter = {
  base: {
    deliveryMode: "direct" as const,
    chunkerMode: "text" as const,
    textChunkLimit: MAX_TEXT_CHUNK_LIMIT,
  },
  attachedResults: {
    channel: "max-messenger",
    sendText: async ({
      cfg,
      to,
      accountId,
      text,
      replyToId,
    }: {
      cfg: unknown;
      to: string;
      accountId?: string | null;
      text: string;
      replyToId?: string | null;
    }) => {
      return sendMaxText({
        cfg: cfg as CoreConfig,
        to,
        accountId: accountId ?? null,
        text,
        replyToId: replyToId ?? null,
      });
    },
    sendMedia: async () => {
      throw new Error(`max-messenger sendMedia: ${NOT_IMPLEMENTED_PHASE_1B}`);
    },
    sendPoll: async () => {
      throw new Error(`max-messenger sendPoll: ${NOT_IMPLEMENTED_PHASE_1B}`);
    },
  },
};
