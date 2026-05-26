import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { m as resolveStorePath } from "./store-C7dehozM.js";
import { t as FinalizedMsgContext } from "./templating-BcdAlwzB.js";
import { t as OutboundReplyPayload } from "./reply-payload-DjPL5qa-.js";
import { t as finalizeInboundContext } from "./inbound-context-BWUKbw3Z.js";
import { a as resolveEnvelopeFormatOptions, n as formatAgentEnvelope } from "./envelope-C3zLks6g.js";
import { t as DispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher.types-CZaOPGb3.js";
import { t as recordInboundSession } from "./session-qBRMrMNr.js";
//#region src/plugin-sdk/direct-dm.d.ts
type DirectDmRoutePeer = {
  kind: "direct";
  id: string;
};
type DirectDmRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
};
type DirectDmRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => ReturnType<typeof resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof formatAgentEnvelope;
      finalizeInboundContext: typeof finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    };
  };
};
/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
declare function dispatchInboundDirectDmWithRuntime(params: {
  cfg: OpenClawConfig;
  runtime: DirectDmRuntime;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: {
    kind: string;
  }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}>;
//#endregion
export { dispatchInboundDirectDmWithRuntime as t };