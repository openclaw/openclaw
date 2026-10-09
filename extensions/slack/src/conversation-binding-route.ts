import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { inspectRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { parseSlackTarget } from "./targets.js";

type SlackRouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type SlackRouteBindingPeer = NonNullable<SlackRouteBinding["match"]["peer"]>;

const slackRouteBindingConfigCache = new WeakMap<
  OpenClawConfig,
  { bindingsRef: OpenClawConfig["bindings"]; normalizedCfg: OpenClawConfig }
>();

function normalizeSlackRouteBindingPeer(peer: SlackRouteBindingPeer): SlackRouteBindingPeer {
  const rawId = peer.id.trim();
  if (!rawId || rawId === "*") {
    return peer;
  }

  try {
    const target = parseSlackTarget(rawId, {
      defaultKind: peer.kind === "direct" ? "user" : "channel",
    });
    if (!target || (target.kind === "user") !== (peer.kind === "direct")) {
      return peer;
    }
    const normalizedId = target.teamId
      ? `team:${target.teamId}:${target.kind}:${target.id}`
      : target.id;
    return normalizedId === peer.id ? peer : { ...peer, id: normalizedId };
  } catch {
    return peer;
  }
}

export function normalizeSlackRouteBindingConfig(cfg: OpenClawConfig): OpenClawConfig {
  const bindings = cfg.bindings;
  const cached = slackRouteBindingConfigCache.get(cfg);
  if (cached && cached.bindingsRef === bindings) {
    return cached.normalizedCfg;
  }
  if (!Array.isArray(bindings)) {
    return cfg;
  }

  let changed = false;
  const normalizedBindings: NonNullable<OpenClawConfig["bindings"]> = bindings.map((binding) => {
    if (binding.type === "acp" || binding.match.channel.trim().toLowerCase() !== "slack") {
      return binding;
    }
    const peer = binding.match.peer;
    if (!peer) {
      return binding;
    }
    const normalizedPeer = normalizeSlackRouteBindingPeer(peer);
    if (normalizedPeer === peer) {
      return binding;
    }
    changed = true;
    return {
      ...binding,
      match: {
        ...binding.match,
        peer: normalizedPeer,
      },
    };
  });

  const normalizedCfg: OpenClawConfig = changed ? { ...cfg, bindings: normalizedBindings } : cfg;
  slackRouteBindingConfigCache.set(cfg, { bindingsRef: bindings, normalizedCfg });
  return normalizedCfg;
}

export function resolveSlackConversationBindingRoute(params: {
  cfg: OpenClawConfig;
  resolveRoute: NonNullable<
    Parameters<typeof resolveRuntimeConversationBindingRoute>[0]["resolveRoute"]
  >;
  accountId: string;
  baseConversationId: string;
  runtimeBindingThreadId?: string;
  bindingsEnabled: boolean;
  touchBinding?: boolean;
  inspections?: Record<"base" | "thread", ConversationBindingInspection>;
}) {
  const { resolveRoute } = params;
  const resolveRuntime = (
    input: Parameters<typeof resolveRuntimeConversationBindingRoute>[0],
    role: "base" | "thread",
  ) =>
    params.inspections
      ? inspectRuntimeConversationBindingRoute({ ...input, inspection: params.inspections[role] })
      : resolveRuntimeConversationBindingRoute(input);
  let baseRuntimeRoute: RuntimeConversationBindingRouteResult | undefined;
  const resolveBaseRoute = (
    threadInspection?: Parameters<typeof inspectRuntimeConversationBindingRoute>[0]["inspection"],
  ) =>
    (baseRuntimeRoute ??= resolveRuntime(
      {
        resolveRoute: threadInspection
          ? (selection) =>
              inspectRuntimeConversationBindingRoute({
                route: resolveRoute(selection),
                inspection: threadInspection,
              }).route
          : resolveRoute,
        touchBinding: params.touchBinding,
        conversation: {
          channel: "slack",
          accountId: params.accountId,
          conversationId: params.baseConversationId,
        },
      },
      "base",
    ));
  const boundThreadRoute =
    params.bindingsEnabled && params.runtimeBindingThreadId
      ? resolveRuntime(
          {
            resolveRoute: (selection) =>
              selection.bindingRecord || !selection.bindingOwnerAvailable
                ? resolveRoute(selection)
                : resolveBaseRoute(selection.inspection).route,
            touchBinding: params.touchBinding,
            conversation: {
              channel: "slack",
              accountId: params.accountId,
              conversationId: params.runtimeBindingThreadId,
              parentConversationId: params.baseConversationId,
            },
          },
          "thread",
        )
      : null;
  const runtimeRoute: RuntimeConversationBindingRouteResult = !params.bindingsEnabled
    ? {
        bindingOwnerAvailable: true,
        route: resolveRoute({
          inspection: { status: "available", binding: null },
          bindingOwnerAvailable: true,
          bindingRecord: null,
        }),
        bindingRecord: null,
        boundSessionKey: undefined,
      }
    : boundThreadRoute &&
        (boundThreadRoute.bindingRecord || boundThreadRoute.bindingOwnerAvailable === false)
      ? boundThreadRoute
      : resolveBaseRoute();
  const configuredRoute =
    params.bindingsEnabled && !runtimeRoute.boundSessionKey && !runtimeRoute.bindingRecord
      ? resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route: runtimeRoute.route,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: params.baseConversationId,
          },
        })
      : null;
  return {
    runtimeRoute,
    configuredRoute,
    route: runtimeRoute.boundSessionKey
      ? runtimeRoute.route
      : (configuredRoute?.route ?? runtimeRoute.route),
  };
}
