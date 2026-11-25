import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { parseMergeForwardContent } from "./message-content.js";
import type { getMessageFeishu } from "./send.js";

type FeishuConfig = NonNullable<NonNullable<ClawdbotConfig["channels"]>["feishu"]>;
type FeishuMessage = FeishuMessageEvent["message"];
type FeishuSender = FeishuMessageEvent["sender"];
type TestConfigBase = Record<string, unknown> & { channels?: Record<string, unknown> };
type FeishuSecretRefPolicyCase = {
  name: string;
  provider: string;
  defaultEnv?: string;
  providers: NonNullable<NonNullable<ClawdbotConfig["secrets"]>["providers"]>;
  configured: boolean;
};

export const FEISHU_SELECTED_SECRET_ENV = "FEISHU_SECRET_REF_SELECTED_TEST";
export const FEISHU_SIBLING_SECRET_ENV = "FEISHU_SECRET_REF_SIBLING_TEST";
const selected = FEISHU_SELECTED_SECRET_ENV;
const sibling = FEISHU_SIBLING_SECRET_ENV;
const env = (id: string) => ({ source: "env" as const, allowlist: [id] });
function policyCase(
  name: string,
  source?: FeishuSecretRefPolicyCase["providers"][string],
  configured = false,
  useDefault = false,
): FeishuSecretRefPolicyCase {
  return {
    name,
    configured,
    provider: source ? "corp-env" : "unconfigured",
    providers: source ? { "corp-env": source } : {},
    ...(useDefault ? { defaultEnv: "corp-env" } : {}),
  };
}

export const feishuSecretRefPolicyCases: FeishuSecretRefPolicyCase[] = [
  policyCase("unconfigured provider alias"),
  policyCase("provider configured with a non-env source", { source: "file", path: "/unused" }),
  policyCase("provider allowlist excluding the selected credential", env(sibling), false, true),
  policyCase("configured env provider allowing the selected credential", env(selected), true, true),
  policyCase(
    "selected env default shadowing an exec provider",
    { source: "exec", command: "/unused" },
    true,
    true,
  ),
];

export function createFeishuTestConfig(
  feishu: FeishuConfig,
  base: TestConfigBase = {},
): ClawdbotConfig {
  return { ...base, channels: { ...base.channels, feishu } } as ClawdbotConfig;
}

export function sentMessage(
  messageId: string,
  chatId: string,
): Awaited<ReturnType<typeof import("./send.js").sendMessageFeishu>> {
  return {
    messageId,
    chatId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt: 1,
    },
  };
}

export function withFeishuRuntimeDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const defaults = FeishuConfigSchema.parse({});
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        // Only these defaults survive the generated JSON schema used by the loader.
        domain: defaults.domain,
        connectionMode: defaults.connectionMode,
        webhookPath: defaults.webhookPath,
        dmPolicy: defaults.dmPolicy,
        reactionNotifications: defaults.reactionNotifications,
        typingIndicator: defaults.typingIndicator,
        resolveSenderNames: defaults.resolveSenderNames,
        ...cfg.channels?.feishu,
      },
    },
  };
}

export function createFeishuSecretRefPolicyConfig({
  provider,
  providers,
  defaultEnv,
}: FeishuSecretRefPolicyCase): ClawdbotConfig {
  const account = (appId: string, id: string, providerAlias: string) => ({
    appId,
    appSecret: { source: "env" as const, provider: providerAlias, id },
  });
  return createFeishuTestConfig(
    {
      accounts: {
        selected: account("selected-app", selected, provider),
        sibling: account("sibling-app", sibling, "sibling-env"),
      },
    },
    {
      secrets: {
        defaults: defaultEnv ? { env: defaultEnv } : undefined,
        providers: {
          ...providers,
          "sibling-env": env(sibling),
        },
      },
    },
  );
}

export function createFeishuTestEvent(params: {
  messageId: string;
  sender?: FeishuSender;
  senderOpenId?: string;
  senderUserId?: string;
  senderType?: FeishuSender["sender_type"];
  chatId?: string;
  chatType?: FeishuMessage["chat_type"];
  messageType?: FeishuMessage["message_type"];
  text?: string;
  content?: string;
  message?: Partial<FeishuMessage>;
}): FeishuMessageEvent {
  return {
    sender: params.sender ?? {
      sender_id: {
        open_id: params.senderOpenId ?? "ou-attacker",
        ...(params.senderUserId ? { user_id: params.senderUserId } : {}),
      },
      ...(params.senderType ? { sender_type: params.senderType } : {}),
    },
    message: {
      message_id: params.messageId,
      chat_id: params.chatId ?? "oc-dm",
      chat_type: params.chatType ?? "p2p",
      message_type: params.messageType ?? "text",
      ...params.message,
      content:
        params.content ??
        params.message?.content ??
        JSON.stringify({ text: params.text ?? "hello" }),
    },
  };
}

export function createFeishuTestRoute(
  overrides: Partial<ResolvedAgentRoute> = {},
): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
    ...overrides,
  };
}

type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>>;

export function createConfiguredFeishuRoute(): NonNullable<ConfiguredBindingRoute> {
  type Resolution = NonNullable<ConfiguredBindingRoute["bindingResolution"]>;
  const conversationId = "ou_sender_1";
  const sessionKey = "agent:codex:acp:binding:feishu:default:abc123";
  const conversation = () => ({ channel: "feishu", accountId: "default", conversationId });
  const target = () => ({ conversationId });
  const record = (): Resolution["record"] => ({
    ...createBoundConversation(),
    bindingId: "config:acp:feishu:default:ou_sender_1",
    targetSessionKey: sessionKey,
    conversation: conversation(),
    metadata: { source: "config" },
  });
  const statefulTarget = (): Resolution["statefulTarget"] => ({
    kind: "stateful",
    driverId: "acp",
    sessionKey,
    agentId: "codex",
  });
  const materialize = () => ({ record: record(), statefulTarget: statefulTarget() });
  return {
    bindingResolution: {
      conversation: conversation(),
      compiledBinding: {
        channel: "feishu",
        accountPattern: "default",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "feishu",
            accountId: "default",
            peer: { kind: "direct", id: conversationId },
          },
        },
        bindingConversationId: conversationId,
        target: target(),
        agentId: "codex",
        provider: {
          compileConfiguredBinding: target,
          matchInboundConversation: target,
        },
        targetFactory: { driverId: "acp", materialize },
      },
      match: target(),
      ...materialize(),
    },
    route: createFeishuTestRoute({
      agentId: "codex",
      sessionKey,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
    }),
  };
}

export function createConfiguredBindingReadiness(ok: boolean, error?: string): BindingReadiness {
  return (ok ? { ok: true } : { ok: false, error: error ?? "unknown error" }) as BindingReadiness;
}

export function createBoundConversation(): NonNullable<BoundConversation> {
  return {
    bindingId: "default:oc_group_chat:topic:om_topic_root",
    targetSessionKey: "agent:codex:acp:binding:feishu:default:feedface",
    targetKind: "session",
    conversation: {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    },
    status: "active",
    boundAt: 0,
  };
}

export function replyDispatcher(ensureNoVisibleReplyFallback = vi.fn()) {
  return {
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback,
  };
}

export function senderClient(
  get = vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
) {
  return { contact: { user: { get } } };
}

export function historyMessage(senderId: string, content: string, offset = 0, senderType = "user") {
  return { senderId, senderType, content, createTime: 1710000000000 + offset * 1000 };
}

export function fetchedMessage(
  messageId: string,
  content: string,
  fields: Partial<NonNullable<Awaited<ReturnType<typeof getMessageFeishu>>>> = {},
) {
  return { messageId, chatId: "oc-group", content, contentType: "text", ...fields };
}

export function mergeForwardItem(
  text: string,
  fields: Partial<Parameters<typeof parseMergeForwardContent>[0][number]> & {
    message_id?: string;
  } = {},
) {
  return {
    msg_type: "text",
    upper_message_id: "container",
    body: { content: JSON.stringify({ text }) },
    ...fields,
  };
}
