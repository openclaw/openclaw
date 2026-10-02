import type { Message } from "grammy/types";
import {
  defineStableChannelIngressIdentity,
  type ChannelIngressEventInput,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";
import { isTelegramCommandsAllowFromConfigured } from "./bot/helpers.js";
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_CHANNEL_ID = "telegram";

const telegramIngressIdentity = defineStableChannelIngressIdentity({
  key: "telegram-user-id",
  // Bot API from.id is authenticated by bot-token polling or secret-validated webhooks.
  authentication: "verified",
  normalize: (value) => {
    const normalized = normalizeAllowFrom([value]);
    return normalized.entries[0] ?? (normalized.hasWildcard ? "*" : null);
  },
  sensitivity: "pii",
});

export function createTelegramIngressResolver(params: {
  accountId?: string;
  cfg?: Pick<OpenClawConfig, "accessGroups" | "commands">;
  useDefaultPairingStore?: boolean;
}) {
  return getTelegramRuntime().channel.inbound.ingress.createResolver({
    channelId: TELEGRAM_CHANNEL_ID,
    accountId: params.accountId ?? "default",
    identity: telegramIngressIdentity,
    cfg: params.cfg,
    useDefaultPairingStore: params.useDefaultPairingStore,
  });
}

export function telegramAllowEntries(allow: NormalizedAllowFrom): string[] {
  return [...(allow.hasWildcard ? ["*"] : []), ...allow.entries];
}

export function resolveTelegramNativeCommandBody(params: {
  msg: Pick<Message, "text" | "entities">;
  nativeCommandNames?: ReadonlyMap<string, string>;
  botUsername?: string;
}): string | undefined {
  const entity = params.msg.entities?.find(
    (entry) => entry.type === "bot_command" && entry.offset === 0,
  );
  const text = params.msg.text;
  if (!entity || !text) {
    return undefined;
  }
  const [name, target] = text.slice(1, entity.length).toLowerCase().split("@");
  if (!name || (target && target !== params.botUsername?.toLowerCase())) {
    return undefined;
  }
  const commandName = params.nativeCommandNames?.get(name);
  return commandName ? `/${commandName}${text.slice(entity.length)}` : undefined;
}

function telegramConversation(params: {
  isGroup: boolean;
  chatId: string | number;
  resolvedThreadId?: number;
}) {
  return {
    kind: params.isGroup ? ("group" as const) : ("direct" as const),
    id: String(params.chatId),
    ...(params.resolvedThreadId != null ? { threadId: String(params.resolvedThreadId) } : {}),
  };
}

export async function buildTelegramNativeCommandOwnerContext(params: {
  accountId: string;
  cfg: OpenClawConfig;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: string | number;
  resolvedThreadId?: number;
  senderId: string;
  agentId: string;
  sessionKey: string;
  messageId: string;
  rawBody: string;
}) {
  const conversation = telegramConversation(params);
  // Bind the transport identity to the real command route. Command and room
  // policy still decide admission after this identity-only context is prepared.
  const channelIngress = await createTelegramIngressResolver({
    accountId: params.accountId,
    cfg: params.cfg,
    useDefaultPairingStore: false,
  }).event({
    subject: { stableId: params.senderId },
    conversation,
    contextBinding: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      inboundEventKind: "user_request",
    },
    event: { kind: "native-command", authMode: "none", mayPair: false },
    dmPolicy: params.dmPolicy,
    groupPolicy: "allowlist",
    command: false,
  });
  return getTelegramRuntime().channel.inbound.buildContext({
    channel: "telegram",
    accountId: params.accountId,
    channelIngress,
    messageId: params.messageId,
    from: params.isGroup ? `telegram:group:${params.chatId}` : `telegram:${params.chatId}`,
    sender: { id: params.senderId },
    conversation,
    route: { agentId: params.agentId, routeSessionKey: params.sessionKey },
    reply: { to: `telegram:${params.chatId}`, messageThreadId: params.resolvedThreadId },
    message: { rawBody: params.rawBody, inboundEventKind: "user_request" },
  });
}

export async function resolveTelegramCommandIngressAuthorization(params: {
  accountId: string;
  cfg: OpenClawConfig;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: string | number;
  resolvedThreadId?: number;
  senderId: string;
  effectiveDmAllow?: NormalizedAllowFrom;
  effectiveGroupAllow?: NormalizedAllowFrom;
  eventKind?: ChannelIngressEventInput["kind"];
  allowTextCommands?: boolean;
  hasControlCommand?: boolean;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  includeDmAllowForGroupCommands?: boolean;
  ownerContext?: Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
}) {
  const ownerAccess = resolveCommandAuthorization({
    cfg: params.cfg,
    ctx: params.ownerContext ?? {
      Provider: "telegram",
      AccountId: params.accountId,
      ChatType: params.isGroup ? "group" : "direct",
      SenderId: params.senderId,
    },
    commandAuthorized: false,
  });
  const commandsAllowFromConfigured = isTelegramCommandsAllowFromConfigured(params.cfg);
  const authorizedByConfig = commandsAllowFromConfigured
    ? ownerAccess.isAuthorizedSender
    : ownerAccess.senderIsOwner;
  if (commandsAllowFromConfigured || authorizedByConfig) {
    const authorized = authorizedByConfig;
    const shouldBlockControlCommand =
      params.allowTextCommands === true && params.hasControlCommand === true && !authorized;
    return {
      requested: true,
      authorized,
      authorizedByConfig,
      senderIsOwner: ownerAccess.senderIsOwner,
      assertOwnerCurrent: ownerAccess.assertOwnerCurrent,
      shouldBlockControlCommand,
      reasonCode: shouldBlockControlCommand
        ? ("control_command_unauthorized" as const)
        : ("command_authorized" as const),
    };
  }
  const effectiveDmAllow = params.effectiveDmAllow ?? normalizeAllowFrom([]);
  const effectiveGroupAllow = params.effectiveGroupAllow ?? normalizeAllowFrom([]);
  const commandOwner = [
    ...(params.isGroup && params.includeDmAllowForGroupCommands === false
      ? []
      : telegramAllowEntries(effectiveDmAllow)),
    ...ownerAccess.ownerList,
  ];
  const result = await createTelegramIngressResolver({
    accountId: params.accountId,
    cfg: params.cfg,
  }).command({
    subject: { stableId: params.senderId },
    conversation: telegramConversation(params),
    event: {
      kind: params.eventKind ?? "native-command",
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "allowlist",
    allowFrom: commandOwner,
    groupAllowFrom: params.isGroup ? telegramAllowEntries(effectiveGroupAllow) : [],
    command: {
      allowTextCommands: params.allowTextCommands ?? false,
      hasControlCommand: params.hasControlCommand ?? false,
      modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff ?? "configured",
    },
  });
  return {
    ...result.commandAccess,
    authorizedByConfig,
    senderIsOwner: ownerAccess.senderIsOwner,
    assertOwnerCurrent: ownerAccess.assertOwnerCurrent,
  };
}

export async function resolveTelegramNativeCommandAdmission(
  params: Parameters<typeof resolveTelegramNativeCommandBody>[0] &
    Pick<
      Parameters<typeof resolveTelegramCommandIngressAuthorization>[0],
      "accountId" | "cfg" | "dmPolicy" | "isGroup" | "chatId" | "senderId"
    >,
): Promise<boolean> {
  if (resolveTelegramNativeCommandBody(params) === undefined) {
    return false;
  }
  return (await resolveTelegramCommandIngressAuthorization(params)).authorizedByConfig;
}

export async function resolveTelegramEventIngressAuthorization(params: {
  accountId: string;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: number;
  resolvedThreadId?: number;
  senderId: string;
  effectiveDmAllow: NormalizedAllowFrom;
  effectiveGroupAllow: NormalizedAllowFrom;
  enforceGroupAuthorization: boolean;
  eventKind: Extract<ChannelIngressEventInput["kind"], "reaction" | "button">;
}) {
  const result = await createTelegramIngressResolver({ accountId: params.accountId }).event({
    subject: { stableId: params.senderId },
    conversation: telegramConversation(params),
    event: {
      kind: params.eventKind,
      authMode: "inbound",
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: params.enforceGroupAuthorization ? "allowlist" : "open",
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
    groupAllowFrom: params.enforceGroupAuthorization
      ? telegramAllowEntries(params.effectiveGroupAllow)
      : [],
  });
  return result.ingress;
}
