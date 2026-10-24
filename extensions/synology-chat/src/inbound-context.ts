import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
export type SynologyInboundMessage = {
  resolveChannelIngress: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
  messageId: string;
  body: string;
  from: string;
  senderName: string;
  chatType: string;
  commandAuthorized: boolean;
  chatUserId?: string;
};
