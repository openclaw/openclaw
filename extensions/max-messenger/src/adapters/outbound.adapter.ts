import { MAX_TEXT_CHUNK_LIMIT } from "../constants.js";

const NOT_IMPLEMENTED_PHASE_1A = "not implemented in Phase 1A";

/**
 * Phase 1A outbound adapter.
 *
 * `sendText` records the call and returns a placeholder result; the real
 * `api.sendMessage` wiring lands in Phase 1B alongside the polling supervisor
 * (docs/max-plugin/plan.md §6 Phase 1B).
 *
 * `sendMedia` / `sendPoll` throw — attachments and polls are scoped to
 * Phase 4 / future phases respectively.
 *
 * Shape is `ChatChannelAttachedOutboundOptions` (internal to
 * `openclaw/plugin-sdk/channel-core`); resolved via `createChatChannelPlugin`
 * at the assembly site so we don't depend on the private type alias.
 */
export const maxMessengerOutboundAdapter = {
  base: {
    deliveryMode: "direct" as const,
    chunkerMode: "text" as const,
    textChunkLimit: MAX_TEXT_CHUNK_LIMIT,
  },
  attachedResults: {
    channel: "max-messenger",
    sendText: async ({
      to,
      accountId,
      text,
    }: {
      to: string;
      accountId?: string | null;
      text: string;
    }) => {
      console.warn(
        `[max-messenger:${accountId ?? "default"}] sendText placeholder ` +
          `(Phase 1A scaffolding) to=${to} chars=${text.length}`,
      );
      return { messageId: `phase-1a-stub-${Date.now()}` };
    },
    sendMedia: async () => {
      throw new Error(`max-messenger sendMedia: ${NOT_IMPLEMENTED_PHASE_1A}`);
    },
    sendPoll: async () => {
      throw new Error(`max-messenger sendPoll: ${NOT_IMPLEMENTED_PHASE_1A}`);
    },
  },
};
