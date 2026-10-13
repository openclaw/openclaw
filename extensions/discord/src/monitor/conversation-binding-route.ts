import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import {
  inspectRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  type resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
  resolveRuntimeConversationBindingRouteAsync,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { shouldIgnoreStaleDiscordRouteBinding } from "./route-resolution.js";

type DiscordConversationBindingRouteParams = {
  cfg: OpenClawConfig;
  resolveRoute: NonNullable<
    Parameters<typeof resolveRuntimeConversationBindingRoute>[0]["resolveRoute"]
  >;
  accountId: string;
  runtimeConversationId: string;
  configuredConversationId: string;
  parentConversationId?: string;
  touchBinding?: boolean;
  inspection?: ConversationBindingInspection;
};

function prepareDiscordBindingRoute(params: DiscordConversationBindingRouteParams) {
  let baseRoute: ResolvedAgentRoute | undefined;
  const input = {
    resolveRoute: (
      selection: Parameters<DiscordConversationBindingRouteParams["resolveRoute"]>[0],
    ) => {
      baseRoute = params.resolveRoute(selection);
      return baseRoute;
    },
    touchBinding: params.touchBinding,
    conversation: {
      channel: "discord",
      accountId: params.accountId,
      conversationId: params.runtimeConversationId,
      parentConversationId: params.parentConversationId,
    },
  };
  return { input, getBaseRoute: () => baseRoute };
}

export function resolveDiscordConversationBindingRoute(
  params: DiscordConversationBindingRouteParams & { inspection: ConversationBindingInspection },
) {
  const prepared = prepareDiscordBindingRoute(params);
  const runtimeRoute = inspectRuntimeConversationBindingRoute({
    ...prepared.input,
    inspection: params.inspection,
  });
  return applyDiscordBindingRoute(params, runtimeRoute, prepared.getBaseRoute());
}

export async function resolveDiscordConversationBindingRouteAsync(
  params: DiscordConversationBindingRouteParams,
) {
  const prepared = prepareDiscordBindingRoute(params);
  const runtimeRoute = await resolveRuntimeConversationBindingRouteAsync(prepared.input);
  return applyDiscordBindingRoute(params, runtimeRoute, prepared.getBaseRoute());
}

function applyDiscordBindingRoute(
  params: DiscordConversationBindingRouteParams,
  resolvedRuntimeRoute: RuntimeConversationBindingRouteResult,
  baseRoute: ResolvedAgentRoute | undefined,
) {
  let runtimeRoute = resolvedRuntimeRoute;
  const route = baseRoute ?? runtimeRoute.route;
  if (
    shouldIgnoreStaleDiscordRouteBinding({
      bindingRecord: runtimeRoute.bindingRecord,
      route,
    })
  ) {
    logVerbose(
      `discord: ignoring stale route binding for conversation ${params.runtimeConversationId} (${runtimeRoute.bindingRecord?.targetSessionKey} -> ${route.sessionKey})`,
    );
    runtimeRoute = {
      bindingOwnerAvailable: true,
      bindingRecord: null,
      route: { ...runtimeRoute.route, ...route },
    };
  }
  const configuredRoute = runtimeRoute.bindingRecord
    ? null
    : resolveConfiguredBindingRoute({
        cfg: params.cfg,
        route: runtimeRoute.route,
        conversation: {
          channel: "discord",
          accountId: params.accountId,
          conversationId: params.configuredConversationId,
          parentConversationId: params.parentConversationId,
        },
      });
  return { runtimeRoute, configuredRoute };
}
