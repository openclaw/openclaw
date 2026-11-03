import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";

const MSTEAMS_TEXT_CHUNK_LIMIT = 4000;

export function resolveMSTeamsEffectiveTextChunkLimit(configuredLimit?: number): number {
  return typeof configuredLimit === "number" && configuredLimit > 0
    ? Math.min(configuredLimit, MSTEAMS_TEXT_CHUNK_LIMIT)
    : MSTEAMS_TEXT_CHUNK_LIMIT;
}

// Discovery and the lazy sender share the same limits and delivery contract.
export const msteamsOutboundConfig = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: MSTEAMS_TEXT_CHUNK_LIMIT,
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    resolveMSTeamsEffectiveTextChunkLimit(fallbackLimit),
  pollMaxOptions: 12,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    },
  },
  presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
} satisfies ChannelOutboundAdapter;
