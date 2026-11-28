// Resolve iMessage ingress with fail-closed pairing-store reads.
import { normalizeChannelDmPolicy } from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelIngressContextBinding,
  ChannelIngressIdentityDescriptor,
  ChannelIngressResolver,
  CreateChannelIngressResolverParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";

type GroupPolicy = "allowlist" | "disabled" | "open";

export async function resolveIMessageIngressWithFailClosedStore(params: {
  cfg: OpenClawConfig;
  accountId: string;
  identity: ChannelIngressIdentityDescriptor;
  createResolver: (base: CreateChannelIngressResolverParams) => ChannelIngressResolver;
  sender: string;
  chatId?: number | string | null;
  chatGuid?: string;
  chatIdentifier?: string;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  hasControlCommandInMessage: boolean;
  readStoreAllowFrom?: () => Promise<string[]>;
}): Promise<{
  resolveChannelIngress: (
    contextBinding?: ChannelIngressContextBinding,
  ) => ReturnType<ChannelIngressResolver["message"]>;
  accessDecision: Awaited<ReturnType<ChannelIngressResolver["message"]>>;
}> {
  const readStoreAllowFrom =
    params.readStoreAllowFrom ??
    (() => readChannelAllowFromStore("imessage", process.env, params.accountId));
  const groupPolicy: GroupPolicy =
    params.groupPolicy === "open" || params.groupPolicy === "disabled"
      ? params.groupPolicy
      : "allowlist";
  const buildMessage = (contextBinding?: ChannelIngressContextBinding) => ({
    subject: {
      stableId: params.sender,
      aliases: {
        ...(params.chatId != null ? { "imessage-chat-id": String(params.chatId) } : {}),
        ...(params.chatGuid ? { "imessage-chat-guid": params.chatGuid } : {}),
        ...(params.chatIdentifier ? { "imessage-chat-identifier": params.chatIdentifier } : {}),
      },
    },
    conversation: {
      kind: params.isGroup ? ("group" as const) : ("direct" as const),
      id: params.chatId != null ? String(params.chatId) : params.sender,
    },
    contextBinding,
    dmPolicy: normalizeChannelDmPolicy(params.dmPolicy) ?? "pairing",
    groupPolicy,
    policy: { groupAllowFromFallbackToAllowFrom: false },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    command: {
      allowTextCommands: params.isGroup,
      hasControlCommand: params.hasControlCommandInMessage,
      directGroupAllowFrom: "effective" as const,
    },
  });

  let storeAllowFrom: string[] = [];
  const createIngressResolver = () =>
    params.createResolver({
      channelId: "imessage",
      accountId: params.accountId,
      identity: params.identity,
      cfg: params.cfg,
      readStoreAllowFrom: async () => storeAllowFrom,
    });
  let ingressResolver = createIngressResolver();
  let resolveChannelIngress = (contextBinding?: ChannelIngressContextBinding) =>
    ingressResolver.message(buildMessage(contextBinding));
  let accessDecision = await resolveChannelIngress();
  if (accessDecision.senderAccess.decision === "pairing") {
    storeAllowFrom = await readStoreAllowFrom();
    ingressResolver = createIngressResolver();
    resolveChannelIngress = (contextBinding?: ChannelIngressContextBinding) =>
      ingressResolver.message(buildMessage(contextBinding));
    accessDecision = await resolveChannelIngress();
  }
  return { resolveChannelIngress, accessDecision };
}
