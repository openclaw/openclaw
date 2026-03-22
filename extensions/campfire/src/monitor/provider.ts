import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { registerCampfireWebhookRoute, type CampfireInboundHandler } from "../http/index.js";
import { sendCampfireText } from "../send.js";
import type { ResolvedCampfireAccount } from "../types.js";
import { buildCampfireInboundContext } from "./context.js";

function waitUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

type CampfireGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedCampfireAccount;
  abortSignal: AbortSignal;
  runtime?: unknown;
  getStatus?: () => ChannelAccountSnapshot;
  setStatus?: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  channelRuntime?: {
    reply: {
      finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: Record<string, unknown>;
        cfg: OpenClawConfig;
        dispatcherOptions: {
          deliver: (replyPayload: { text?: string; body?: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<unknown>;
    };
  };
};

type CampfireGatewayAdapter = {
  startAccount: (ctx: CampfireGatewayContext) => Promise<void>;
};

export function createCampfireGateway(params?: {
  registerRoute?: typeof registerCampfireWebhookRoute;
  sendText?: typeof sendCampfireText;
}): CampfireGatewayAdapter {
  const registerRoute = params?.registerRoute ?? registerCampfireWebhookRoute;
  const sendText = params?.sendText ?? sendCampfireText;

  return {
    startAccount: async (ctx) => {
      if (!ctx.account.enabled || !ctx.account.configured) {
        await waitUntilAbort(ctx.abortSignal);
        return;
      }
      const channelRuntime = ctx.channelRuntime;
      if (!channelRuntime) {
        ctx.log?.warn?.(
          `[${ctx.account.accountId}] campfire channelRuntime is unavailable; inbound disabled`,
        );
        await waitUntilAbort(ctx.abortSignal);
        return;
      }

      const onInbound: CampfireInboundHandler = async (payload) => {
        if (ctx.abortSignal.aborted) {
          return;
        }

        const inbound = buildCampfireInboundContext({
          payload,
          allowFrom: ctx.account.allowFrom,
          baseUrl: ctx.account.baseUrl,
        });
        if (!inbound.isAllowed) {
          return;
        }

        const msgCtx = channelRuntime.reply.finalizeInboundContext({
          Body: inbound.text,
          BodyForAgent: inbound.text,
          RawBody: inbound.text,
          CommandBody: inbound.text,
          From: `campfire:${inbound.sender.id}`,
          To: `campfire:room:${inbound.roomId}`,
          SessionKey: inbound.threadKey,
          AccountId: ctx.account.accountId,
          ChatType: "group",
          ConversationLabel: inbound.roomName,
          SenderId: inbound.sender.id,
          SenderName: inbound.sender.name,
          Provider: "campfire",
          Surface: "campfire",
          OriginatingChannel: "campfire",
          OriginatingTo: `campfire:room:${inbound.roomId}`,
          MessageSid: inbound.messageId,
          MessageSidFull: inbound.messageId,
          GroupSpace: inbound.roomName,
          Timestamp: Date.now(),
          CommandAuthorized: true,
        });

        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: ctx.cfg,
          dispatcherOptions: {
            deliver: async (replyPayload: { text?: string; body?: string }) => {
              const text =
                typeof replyPayload.text === "string"
                  ? replyPayload.text
                  : typeof replyPayload.body === "string"
                    ? replyPayload.body
                    : "";
              if (!text) {
                return;
              }
              await sendText(
                inbound.replyUrl,
                text,
                ctx.account.botKey,
                ctx.account.textChunkLimit,
              );
            },
            onError: (err: unknown, info: { kind: string }) => {
              ctx.log?.error?.(
                `[${ctx.account.accountId}] campfire ${info.kind} reply failed: ${String(err)}`,
              );
            },
          },
        });
      };

      const unregister = registerRoute({
        accountId: ctx.account.accountId,
        path: ctx.account.webhookPath,
        webhookSecret: ctx.account.webhookSecret,
        onInbound,
        log: ctx.log,
      });

      try {
        await waitUntilAbort(ctx.abortSignal);
      } finally {
        unregister();
      }
    },
  };
}

export const campfireGateway = createCampfireGateway();
