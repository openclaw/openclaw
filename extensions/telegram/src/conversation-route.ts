import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
  type ConfiguredBindingRouteResult,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
  resolveThreadSessionKeys,
  buildAgentMainSessionKey,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { buildTelegramParentPeer, shouldUseTelegramDmThreadSession } from "./bot/helpers.js";
import {
  resolveTelegramDirectPeerId,
  resolveTelegramNamedAccountBaseSessionKey,
} from "./dm-session-key.js";
import type { TelegramThreadSpec } from "./thread-spec.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

type TelegramResolvedRoute = ReturnType<typeof resolveAgentRoute>;
type ConfiguredTelegramBinding = NonNullable<ConfiguredBindingRouteResult["bindingResolution"]>;

type TelegramConversationBindingMode =
  | { kind: "none" }
  | {
      kind: "configured";
      binding: ConfiguredTelegramBinding;
      sessionKey: string;
    }
  | {
      kind: "runtime-bound";
      sessionKey: string;
    }
  | { kind: "plugin-owned-runtime"; pluginId: string };

type TelegramConversationRouteResult = {
  route: TelegramResolvedRoute;
  bindingMode: TelegramConversationBindingMode;
  bindingOwnerAvailable: boolean;
  runtimeBinding?: NonNullable<
    ReturnType<typeof resolveRuntimeConversationBindingRoute>["bindingRecord"]
  >;
};

type ResolveTelegramConversationRouteParams = {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number | string;
  isGroup: boolean;
  threadSpec: TelegramThreadSpec;
  senderId?: string | number | null;
  topicAgentId?: string | null;
};

function prepareTelegramConversationRoute(params: ResolveTelegramConversationRouteParams) {
  const resolvedThreadId = params.threadSpec.id;
  const conversationId = buildTelegramConversationId({
    chatId: params.chatId,
    thread: params.threadSpec,
  });
  const peerId = params.isGroup
    ? conversationId
    : resolveTelegramDirectPeerId({ chatId: params.chatId, senderId: params.senderId });
  const parentPeer = buildTelegramParentPeer({
    isGroup: params.isGroup,
    resolvedThreadId,
    chatId: params.chatId,
  });
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: peerId,
    },
    parentPeer,
  });

  const rawTopicAgentId = params.topicAgentId?.trim();
  if (rawTopicAgentId) {
    // Preserve the configured topic agent ID so topic-bound sessions stay stable
    // even when that agent is not present in the current config snapshot.
    const topicAgentId = sanitizeAgentId(rawTopicAgentId);
    const sessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentSessionKey({
        agentId: topicAgentId,
        mainKey: params.cfg.session?.mainKey,
        channel: "telegram",
        accountId: params.accountId,
        peer: { kind: params.isGroup ? "group" : "direct", id: peerId },
        dmScope: route.dmScope,
        groupScope: route.groupScope,
        identityLinks: params.cfg.session?.identityLinks,
      }),
    );
    const mainSessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentMainSessionKey({
        agentId: topicAgentId,
        mainKey: params.cfg.session?.mainKey,
      }),
    );
    route = {
      ...route,
      agentId: topicAgentId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey,
        mainSessionKey,
      }),
    };
    logVerbose(
      `telegram: topic route override: topic=${resolvedThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`,
    );
  }

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "telegram",
      accountId: params.accountId,
      conversationId: params.isGroup ? conversationId : peerId,
      parentConversationId:
        conversationId !== String(params.chatId) || params.isGroup
          ? String(params.chatId)
          : undefined,
    },
  });
  route = configuredRoute.route;
  const bindingMode: TelegramConversationBindingMode = configuredRoute.bindingResolution
    ? {
        kind: "configured",
        binding: configuredRoute.bindingResolution,
        sessionKey: configuredRoute.boundSessionKey ?? route.sessionKey,
      }
    : { kind: "none" };

  return {
    route,
    bindingMode,
    conversation: {
      channel: "telegram",
      accountId: params.accountId,
      conversationId,
    },
  };
}

function applyTelegramRuntimeRoute(
  prepared: ReturnType<typeof prepareTelegramConversationRoute>,
  runtimeRoute: RuntimeConversationBindingRouteResult,
): TelegramConversationRouteResult {
  const route = runtimeRoute.route;
  let bindingMode: TelegramConversationBindingMode = prepared.bindingMode;
  const runtimeBindingConversationId = prepared.conversation.conversationId;
  if (runtimeRoute.bindingRecord) {
    bindingMode = runtimeRoute.boundSessionKey
      ? { kind: "runtime-bound", sessionKey: runtimeRoute.boundSessionKey }
      : { kind: "plugin-owned-runtime", pluginId: runtimeRoute.pluginId ?? "" };
    logVerbose(
      runtimeRoute.boundSessionKey
        ? `telegram: routed via bound conversation ${runtimeBindingConversationId} -> ${runtimeRoute.boundSessionKey}`
        : `telegram: plugin-bound conversation ${runtimeBindingConversationId}`,
    );
  }

  return {
    route,
    bindingMode,
    bindingOwnerAvailable: runtimeRoute.bindingOwnerAvailable ?? true,
    ...(runtimeRoute.bindingRecord
      ? {
          runtimeBinding: {
            ...runtimeRoute.bindingRecord,
            conversation: { ...runtimeRoute.bindingRecord.conversation },
          },
        }
      : {}),
  };
}

export async function resolveTelegramConversationRoute(
  params: ResolveTelegramConversationRouteParams,
): Promise<TelegramConversationRouteResult> {
  const prepared = prepareTelegramConversationRoute(params);
  return applyTelegramRuntimeRoute(
    prepared,
    await resolveRuntimeConversationBindingRouteAsync(prepared),
  );
}

/** Revalidates route ownership without extending runtime-binding liveness. */
export function inspectTelegramConversationRoute(
  params: ResolveTelegramConversationRouteParams,
): TelegramConversationRouteResult {
  const prepared = prepareTelegramConversationRoute(params);
  return applyTelegramRuntimeRoute(
    prepared,
    resolveRuntimeConversationBindingRoute({ ...prepared, touchBinding: false }),
  );
}

/** Extend only the inspected binding after native command authorization. */
export async function touchTelegramConversationRoute(
  inspected: TelegramConversationRouteResult,
): Promise<void> {
  const captured = inspected.runtimeBinding;
  if (!captured) {
    return;
  }
  const bindings = getSessionBindingService();
  const assertRouteCurrent = () => {
    const current = bindings.resolveByConversation(captured.conversation);
    if (
      !current ||
      current.bindingId !== captured.bindingId ||
      current.targetSessionKey !== captured.targetSessionKey ||
      current.targetKind !== captured.targetKind ||
      current.boundAt !== captured.boundAt ||
      current.status !== captured.status
    ) {
      throw new Error("Telegram command route changed; send a new request.");
    }
  };
  assertRouteCurrent();
  await bindings.touchAsync(captured.bindingId, undefined, captured.conversation);
  assertRouteCurrent();
}

export function resolveTelegramConversationBaseSessionKey(
  params: Parameters<typeof resolveTelegramNamedAccountBaseSessionKey>[1],
): string {
  return resolveTelegramNamedAccountBaseSessionKey(
    resolveDefaultTelegramAccountId(params.cfg),
    params,
  );
}

export function resolveTelegramTargetSession(params: {
  cfg: OpenClawConfig;
  route: TelegramResolvedRoute;
  chatId: number | string;
  isGroup: boolean;
  senderId?: string | number | null;
  dmThreadId?: number;
  botHasTopicsEnabled?: boolean;
}): string {
  const baseSessionKey = resolveTelegramConversationBaseSessionKey(params);
  const threadKeys =
    shouldUseTelegramDmThreadSession({
      dmThreadId: params.dmThreadId,
      botHasTopicsEnabled: params.botHasTopicsEnabled,
    }) && params.dmThreadId != null
      ? resolveThreadSessionKeys({
          baseSessionKey,
          threadId: `${params.chatId}:${params.dmThreadId}`,
        })
      : null;
  return threadKeys?.sessionKey ?? baseSessionKey;
}
