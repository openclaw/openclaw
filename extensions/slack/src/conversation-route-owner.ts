import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { resolveAccountEntry, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { hasImplicitDefaultSlackAccount } from "./accounts.js";
import {
  normalizeSlackRouteBindingConfig,
  resolveSlackConversationBindingRoute,
} from "./conversation-binding-route.js";
import { getSlackInstallationKind } from "./installation-identity-state.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
} from "./monitor/workspace-routing.js";
import { parseSlackTarget } from "./targets.js";

type BindingRouteInput = Omit<
  Parameters<typeof resolveSlackConversationBindingRoute>[0],
  "inspections"
>;
type BindingInspections = Parameters<typeof resolveSlackConversationBindingRoute>[0]["inspections"];
type RouteOwner = ReturnType<NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>>;
type PreparedRouteOwner =
  | { kind: "terminal"; owner: null | { kind: "unavailable" } }
  | {
      kind: "prepared";
      route: BindingRouteInput;
      resolve(inspections: BindingInspections): RouteOwner;
    };

function prepareSlackConversationRouteOwner(
  params: Parameters<NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>>[0],
): PreparedRouteOwner {
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = resolveAccountEntry(params.cfg.channels?.slack?.accounts, accountId);
  if (
    params.cfg.channels?.slack?.enabled === false ||
    accountConfig?.enabled === false ||
    (!accountConfig &&
      (accountId !== DEFAULT_ACCOUNT_ID || !hasImplicitDefaultSlackAccount(params.cfg)))
  ) {
    return { kind: "terminal", owner: null };
  }
  const installationKind = getSlackInstallationKind(accountId);
  const direct = params.conversation.kind === "direct";
  const target = parseSlackTarget(params.conversation.peerId, {
    defaultKind: direct ? "user" : "channel",
  });
  if (!target || target.kind !== (direct ? "user" : "channel")) {
    return { kind: "terminal", owner: null };
  }
  // Qualified targets remain durable Enterprise evidence after monitor teardown. Only an
  // unqualified target is ambiguous while installation identity is temporarily degraded.
  const targetIsEnterprise = Boolean(target.teamId);
  if (!targetIsEnterprise && (installationKind === "degraded" || !installationKind)) {
    return { kind: "terminal", owner: { kind: "unavailable" } };
  }
  if (targetIsEnterprise && installationKind === "workspace") {
    return { kind: "terminal", owner: null };
  }
  const contextTeamId = params.conversation.context?.teamId?.trim();
  if (
    contextTeamId &&
    target.teamId &&
    contextTeamId.toLowerCase() !== target.teamId.toLowerCase()
  ) {
    return { kind: "terminal", owner: null };
  }
  const teamId = contextTeamId ?? target.teamId;
  if (
    !direct &&
    params.conversation.nativeChannelId &&
    params.conversation.nativeChannelId.toLowerCase() !== target.id.toLowerCase()
  ) {
    return { kind: "terminal", owner: null };
  }
  const enterpriseRoute = installationKind === "enterprise" || targetIsEnterprise;
  if (enterpriseRoute && !teamId) {
    return { kind: "terminal", owner: null };
  }
  const enterpriseScope = enterpriseRoute && teamId ? { teamId } : undefined;
  const resolveRoute = ({
    boundAgentId,
    bindingOwnerAvailable,
  }: {
    boundAgentId?: string;
    bindingOwnerAvailable: boolean;
  }) =>
    resolveAgentRoute({
      cfg:
        boundAgentId || !bindingOwnerAvailable
          ? { session: params.cfg.session }
          : normalizeSlackRouteBindingConfig(params.cfg),
      defaultAgentId: boundAgentId,
      channel: "slack",
      accountId,
      teamId,
      peer: {
        kind: params.conversation.kind,
        id: qualifySlackRoutePeerId({
          id: target.id,
          kind: direct ? "user" : "channel",
          eventScope: enterpriseScope,
        }),
      },
    });
  const baseConversationId = qualifySlackConversationId(
    direct ? `user:${target.id}` : target.id,
    enterpriseScope,
  );
  const route = {
    cfg: params.cfg,
    resolveRoute,
    accountId,
    baseConversationId,
    runtimeBindingThreadId: params.conversation.threadId,
    bindingsEnabled: !enterpriseRoute,
    touchBinding: false,
  };
  return {
    kind: "prepared",
    route,
    resolve(
      inspections: NonNullable<
        Parameters<typeof resolveSlackConversationBindingRoute>[0]["inspections"]
      >,
    ) {
      const bindingRoute = resolveSlackConversationBindingRoute({ ...route, inspections });
      if (!bindingRoute.runtimeRoute.bindingOwnerAvailable) {
        return { kind: "unavailable" as const };
      }
      if (bindingRoute.runtimeRoute.pluginId) {
        return {
          kind: "plugin" as const,
          pluginId: bindingRoute.runtimeRoute.pluginId,
          fallbackAgentId: bindingRoute.route.agentId,
        };
      }
      return {
        kind: "agent" as const,
        agentId:
          bindingRoute.runtimeRoute.boundAgentId ??
          bindingRoute.configuredRoute?.boundAgentId ??
          bindingRoute.route.agentId,
      };
    },
  };
}

async function prepareSlackConversationRouteOwnersAsync(
  inputs: readonly Parameters<
    NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>
  >[0][],
  inspectBindings: Parameters<
    NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwnersAsync"]>
  >[1],
) {
  const prepared = inputs.map(prepareSlackConversationRouteOwner);
  const refs = prepared.flatMap((item) =>
    item.kind === "prepared" && item.route.bindingsEnabled
      ? [
          {
            channel: "slack",
            accountId: item.route.accountId,
            conversationId: item.route.baseConversationId,
          },
          ...(item.route.runtimeBindingThreadId
            ? [
                {
                  channel: "slack",
                  accountId: item.route.accountId,
                  conversationId: item.route.runtimeBindingThreadId,
                  parentConversationId: item.route.baseConversationId,
                },
              ]
            : []),
        ]
      : [],
  );
  const inspect = await inspectBindings(refs);
  let index = 0;
  const nextInspection = () => {
    const position = index++;
    return () => {
      const inspection = inspect()[position];
      if (!inspection) {
        throw new Error("Slack binding owner returned an incomplete selection");
      }
      return inspection;
    };
  };
  return prepared.map((item) => {
    if (item.kind === "terminal") {
      return () => item.owner;
    }
    const base = item.route.bindingsEnabled
      ? nextInspection()
      : () => ({ status: "available" as const, binding: null });
    const thread =
      item.route.bindingsEnabled && item.route.runtimeBindingThreadId ? nextInspection() : base;
    return () => item.resolve({ base: base(), thread: thread() });
  });
}

export const slackConversationRouteOwners = {
  prepareConversationRouteOwnersAsync: prepareSlackConversationRouteOwnersAsync,
};
