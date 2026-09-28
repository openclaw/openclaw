import {
  dispatchPluginInteractiveHandler,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import type { FeishuCardActionEvent } from "./card-action.js";
import { resolveFeishuChatType } from "./chat-type.js";
import { createFeishuClient } from "./client.js";
import {
  hasExplicitFeishuGroupConfig,
  resolveFeishuDmIngressAccess,
  resolveFeishuGroupConfig,
  resolveFeishuGroupConversationIngressAccess,
  resolveFeishuGroupSenderActivationIngressAccess,
} from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";

export type FeishuInteractiveHandlerContext = {
  channel: "feishu";
  accountId: string;
  conversationId: string;
  senderId: string;
  messageId: string;
  chatType: "p2p" | "group";
  callback: {
    data: string;
    namespace: string;
    payload: string;
    action: FeishuCardActionEvent["action"];
  };
};

export type FeishuInteractiveHandlerRegistration = PluginInteractiveRegistration<
  FeishuInteractiveHandlerContext,
  "feishu"
>;

export async function dispatchFeishuPluginCardAction(params: {
  event: FeishuCardActionEvent;
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  data: string;
  channelRuntime?: PluginRuntime["channel"];
}) {
  const { event, account: initialAccount } = params;
  return await dispatchPluginInteractiveHandler<FeishuInteractiveHandlerRegistration>({
    channel: "feishu",
    data: params.data,
    // The card-action owner already claims account-scoped callback tokens.
    invoke: async ({ registration, namespace, payload }) => {
      const chatId = event.context.chat_id?.trim();
      const messageId = (event.context.open_message_id ?? event.open_message_id)?.trim();
      if (
        !initialAccount.enabled ||
        !chatId ||
        !messageId ||
        messageId.startsWith("card-action-c-")
      ) {
        throw new Error(
          "Feishu plugin callback requires an enabled account and original card context",
        );
      }
      // Callback hints are not authority for choosing a less restrictive DM policy.
      // Unknown chat metadata must not default to p2p on this path.
      const response = await createFeishuClient(initialAccount).im.chat.get({
        path: { chat_id: chatId },
      });
      const chatType =
        response?.code === 0 ? resolveFeishuChatType(response.data ?? {}) : undefined;
      if (!chatType) {
        throw new Error("Feishu plugin callback chat type is unavailable");
      }
      const runtime = getFeishuRuntime();
      // SAFETY: current() supplies host-validated config; these resolvers only read it.
      const cfg = runtime.config.current() as ClawdbotConfig;
      const account = resolveFeishuRuntimeAccount({ cfg, accountId: initialAccount.accountId });
      if (!account.enabled || account.appId !== initialAccount.appId) {
        throw new Error("Feishu plugin callback account changed during lookup");
      }
      if (chatType === "p2p") {
        const channel = params.channelRuntime ?? runtime.channel;
        const access = await resolveFeishuDmIngressAccess({
          cfg,
          accountId: account.accountId,
          dmPolicy: account.config.dmPolicy,
          allowFrom: account.config.allowFrom,
          readAllowFromStore: () =>
            channel.pairing.readAllowFromStore({
              channel: "feishu",
              accountId: account.accountId,
            }),
          senderOpenId: event.operator.open_id,
          senderUserId: event.operator.user_id,
          conversationId: event.operator.open_id,
          mayPair: false,
        });
        if (access.ingress.admission !== "dispatch") {
          throw new Error("Feishu plugin callback sender is not allowed");
        }
      } else {
        const group = resolveFeishuGroupConfig({ cfg: account.config, groupId: chatId });
        if (group?.enabled === false) {
          throw new Error("Feishu plugin callback group is disabled");
        }
        const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
          providerConfigPresent: cfg.channels?.feishu !== undefined,
          groupPolicy: account.config.groupPolicy,
          defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
        });
        const access = await resolveFeishuGroupConversationIngressAccess({
          cfg,
          accountId: account.accountId,
          chatId,
          groupPolicy,
          groupAllowFrom: account.config.groupAllowFrom,
          groupExplicitlyConfigured: hasExplicitFeishuGroupConfig({
            cfg: account.config,
            groupId: chatId,
          }),
        });
        if (access.ingress.admission !== "dispatch") {
          throw new Error("Feishu plugin callback group is not allowed");
        }
        const sender = await resolveFeishuGroupSenderActivationIngressAccess({
          cfg,
          accountId: account.accountId,
          chatId,
          allowFrom: group?.allowFrom?.length
            ? group.allowFrom
            : account.config.groupSenderAllowFrom,
          senderOpenId: event.operator.open_id,
          senderUserId: event.operator.user_id,
          requireMention: false,
          mentionedBot: true,
        });
        if (sender.senderAccess.decision !== "allow" || sender.ingress.admission !== "dispatch") {
          throw new Error("Feishu plugin callback sender is not allowed");
        }
      }
      if (runtime.config.current() !== cfg) {
        throw new Error("Feishu plugin callback configuration changed during authorization");
      }
      return await registration.handler({
        channel: "feishu",
        accountId: account.accountId,
        conversationId: chatId,
        senderId: event.operator.open_id,
        messageId,
        chatType,
        callback: { data: params.data, namespace, payload, action: event.action },
      });
    },
  });
}
