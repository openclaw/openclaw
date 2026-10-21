import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import {
  getSessionBindingService,
  resolveConfiguredBindingRoute,
  inspectRuntimeConversationBindingRoute,
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
  normalizeAgentId,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
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
  runtimeBinding?: NonNullable<RuntimeConversationBindingRouteResult["bindingRecord"]>;
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
  const routeInput = {
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? ("group" as const) : ("direct" as const),
      id: peerId,
    },
    parentPeer,
  };
  const conversation = {
    channel: "telegram",
    accountId: params.accountId,
    conversationId,
  };
  // The binding owner supplies its agent before ordinary agent selection, which rejects an
  // ambiguous multi-agent roster even when this conversation's binding already names its
  // agent. Session-only config keeps scope derivation from consulting the roster at all.
  // Selection runs inside the binding inspection, so the agent and binding come from one read.
  const selectRoute = ({ boundAgentId }: { boundAgentId?: string }) =>
    finishTelegramConversationRoute(
      params,
      { conversationId, peerId },
      boundAgentId
        ? resolveAgentRoute({
            ...routeInput,
            cfg: { session: params.cfg.session },
            defaultAgentId: boundAgentId,
          })
        : resolveAgentRoute({ ...routeInput, cfg: params.cfg }),
    );
  return { conversation, selectRoute };
}

function finishTelegramConversationRoute(
  params: ResolveTelegramConversationRouteParams,
  ids: { conversationId: string; peerId: string },
  selectedRoute: TelegramResolvedRoute,
) {
  const { conversationId, peerId } = ids;
  let route = selectedRoute;

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

  return { route, bindingMode };
}

function applyTelegramRuntimeRoute(
  prepared: ReturnType<typeof finishTelegramConversationRoute>,
  runtimeRoute: RuntimeConversationBindingRouteResult,
): TelegramConversationRouteResult {
  const route = runtimeRoute.route;
  let bindingMode: TelegramConversationBindingMode = prepared.bindingMode;
  if (runtimeRoute.bindingRecord) {
    bindingMode = runtimeRoute.boundSessionKey
      ? { kind: "runtime-bound", sessionKey: runtimeRoute.boundSessionKey }
      : { kind: "plugin-owned-runtime", pluginId: runtimeRoute.pluginId ?? "" };
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

async function resolveTelegramRuntimeRoute(
  params: ResolveTelegramConversationRouteParams,
  touchBinding: boolean,
): Promise<TelegramConversationRouteResult> {
  const { conversation, selectRoute } = prepareTelegramConversationRoute(params);
  // SAFETY: Widens the initializer; TS does not see the route callback's assignment.
  let selected = undefined as ReturnType<typeof selectRoute> | undefined;
  const runtimeRoute = await resolveRuntimeConversationBindingRouteAsync({
    conversation,
    touchBinding,
    resolveRoute: (selection) => (selected = selectRoute(selection)).route,
  });
  if (!selected) {
    throw new Error("Telegram route selection did not run");
  }
  return applyTelegramRuntimeRoute(selected, runtimeRoute);
}

export async function resolveTelegramConversationRoute(
  params: ResolveTelegramConversationRouteParams,
): Promise<TelegramConversationRouteResult> {
  return resolveTelegramRuntimeRoute(params, true);
}

/** Prepare route policy once; the supplied binding facts are checked at the effect. */
export function prepareTelegramConversationRouteInspection(
  params: ResolveTelegramConversationRouteParams,
) {
  const { conversation, selectRoute } = prepareTelegramConversationRoute(params);
  return {
    conversation,
    resolve(inspection: ConversationBindingInspection) {
      // SAFETY: Widens the initializer; TS does not see the route callback's assignment.
      let selected = undefined as ReturnType<typeof selectRoute> | undefined;
      const runtimeRoute = inspectRuntimeConversationBindingRoute({
        inspection,
        resolveRoute: (selection) => (selected = selectRoute(selection)).route,
      });
      if (!selected) {
        throw new Error("Telegram route selection did not run");
      }
      return applyTelegramRuntimeRoute(selected, runtimeRoute);
    },
  };
}

export async function inspectTelegramConversationRouteAsync(
  params: ResolveTelegramConversationRouteParams,
): Promise<TelegramConversationRouteResult> {
  return resolveTelegramRuntimeRoute(params, false);
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
  await bindings.touchAsync(captured.bindingId, undefined, captured.conversation);
}

function resolveTelegramConversationBaseSessionKey(
  params: Parameters<typeof resolveTelegramNamedAccountBaseSessionKey>[1],
): string {
  return resolveTelegramNamedAccountBaseSessionKey(
    resolveDefaultTelegramAccountId(params.cfg),
    params,
  );
}

/** Outbound DMs reuse inbound binding facts: only an unbound named account is a fallback. */
export function resolveTelegramOutboundDirectBaseSessionKey(params: {
  cfg: OpenClawConfig;
  route: Pick<TelegramResolvedRoute, "agentId" | "accountId" | "sessionKey">;
  chatId: string;
}): string {
  const resolvedRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    // Unbound destinations keep the caller's agent instead of requiring a fleet default.
    defaultAgentId: params.route.agentId,
    accountId: params.route.accountId,
    peer: { kind: "direct", id: params.chatId },
  });
  const isOwnBinding =
    normalizeAgentId(resolvedRoute.agentId) === normalizeAgentId(params.route.agentId);
  return resolveTelegramConversationBaseSessionKey({
    cfg: params.cfg,
    route: isOwnBinding ? resolvedRoute : { ...params.route, matchedBy: "default" },
    chatId: params.chatId,
    isGroup: false,
  });
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
  return shouldUseTelegramDmThreadSession(params) && params.dmThreadId != null
    ? resolveThreadSessionKeys({
        baseSessionKey,
        threadId: `${params.chatId}:${params.dmThreadId}`,
      }).sessionKey
    : baseSessionKey;
}
