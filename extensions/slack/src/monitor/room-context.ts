import { buildUntrustedChannelMetadata } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export function resolveSlackRoomContextHints(params: {
  isRoomish: boolean;
  channelInfo?: { topic?: string; purpose?: string };
  channelConfig?: { systemPrompt?: string | null } | null;
}): {
  untrustedChannelMetadata?: ReturnType<typeof buildUntrustedChannelMetadata>;
  groupSystemPrompt?: string;
} {
  const untrustedChannelMetadata = params.isRoomish
    ? buildUntrustedChannelMetadata({
        source: "slack",
        label: "Slack channel description",
        entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
      })
    : undefined;

  const groupSystemPrompt = params.isRoomish
    ? normalizeOptionalString(params.channelConfig?.systemPrompt)
    : undefined;

  return {
    untrustedChannelMetadata,
    groupSystemPrompt,
  };
}
