import type { ChannelOutboundAdapter } from "../runtime-api.js";

// Direct sends can carry plugin-only flags and a display name that the shared
// channel adapter context does not model.
export type FeishuOutboundSendMedia = (
  params: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
    propagateMediaUploadFailure?: boolean;
    filename?: string;
  },
) => ReturnType<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;
