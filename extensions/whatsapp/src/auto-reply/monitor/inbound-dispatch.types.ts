import type {
  ChannelInboundTurnPlan,
  hasVisibleInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import type { createChannelMessageReplyPipeline, getReplyFromConfig } from "./runtime-api.js";

export type ChannelReplyOnModelSelected = NonNullable<
  ReturnType<typeof createChannelMessageReplyPipeline>["onModelSelected"]
>;

export type WhatsAppDispatchPipeline = {
  responsePrefix?: string;
} & Record<string, unknown>;

export type WhatsAppReplyPlan = {
  afterRecord: () => void;
  dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]>;
  delivery: ChannelInboundTurnPlan["delivery"];
  replyOptions: NonNullable<ChannelInboundTurnPlan["replyOptions"]>;
  replyResolver: typeof getReplyFromConfig;
  finalize: (
    dispatchResult: NonNullable<Parameters<typeof hasVisibleInboundReplyDispatch>[0]>,
  ) => boolean;
};
