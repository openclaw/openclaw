import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import {
  resolveMessageActionTurnCapability,
  selectMessageActionRequesterIdentity,
} from "../gateway/message-action-turn-capability.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import { resolveAgentScopedOutboundMediaAccess } from "../media/read-capability.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { stringEnum } from "./schema/string-enum.js";
import {
  asToolParamsRecord,
  jsonResult,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./tools/common.js";

type CurrentTurnRoute = DeliveryContext & { channel: string; to: string };
type CurrentTurnDeliveryContext = OpenClawPluginToolContext & {
  runId?: string;
  messageActionTurnCapability?: string;
};
const outputSchema = Type.Object(
  {
    status: stringEnum(["sent", "suppressed", "partial_failed", "failed"] as const),
    channel: Type.String(),
    to: Type.String(),
    messageId: Type.Optional(Type.String()),
    suppressionReason: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    sentBeforeError: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type CurrentTurnDelivery = {
  route: CurrentTurnRoute;
  send: (params: { text?: string; mediaUrl?: string }) => Promise<Static<typeof outputSchema>>;
};
const loadMessageActionRunner = createLazyRuntimeModule(
  () => import("../infra/outbound/message-action-runner.js"),
);
export function projectCurrentTurnDeliveryResult(
  result: MessageActionResult,
  route: CurrentTurnRoute,
) {
  const send = result.kind === "send" ? result.sendResult : undefined;
  const id = send?.result?.messageId;
  const status = send?.deliveryStatus ?? (id ? "sent" : "failed");
  return {
    status,
    channel: route.channel,
    to: route.to,
    ...(id ? { messageId: id } : {}),
    ...(send?.suppressionReason ? { suppressionReason: send.suppressionReason } : {}),
    ...(send?.error ? { error: send.error } : {}),
    ...(send?.sentBeforeError ? { sentBeforeError: true } : {}),
    ...(!send ? { error: "current-turn delivery returned no send result" } : {}),
  };
}
export function createCurrentTurnDelivery(
  params: CurrentTurnDeliveryContext,
): CurrentTurnDelivery | undefined {
  const deliveryContext = normalizeDeliveryContext(params.deliveryContext);
  const { agentId, sessionKey, runId } = params;
  const token = params.messageActionTurnCapability;
  const activeRegistry = getActivePluginRegistry();
  const activeRegistryVersion = getActivePluginRegistryVersion();
  if (
    !deliveryContext?.channel ||
    !deliveryContext.to ||
    !agentId ||
    !sessionKey ||
    !runId ||
    !token ||
    !activeRegistry
  ) {
    return undefined;
  }
  if (
    activeRegistry.channels.find((entry) => entry.plugin.id === deliveryContext.channel)?.plugin
      .outbound?.deliveryMode === "gateway"
  ) {
    return undefined;
  }
  const route: CurrentTurnRoute = {
    channel: deliveryContext.channel,
    to: deliveryContext.to,
    accountId: deliveryContext.accountId,
    threadId: deliveryContext.threadId,
  };
  const resolveAuthorization = () => {
    const authorization =
      getActivePluginRegistry() === activeRegistry &&
      getActivePluginRegistryVersion() === activeRegistryVersion
        ? resolveMessageActionTurnCapability({
            token,
            agentId,
            runId,
            sessionKey,
            sessionId: params.sessionId,
          })
        : undefined;
    if (!authorization) {
      throw new Error("current-turn delivery capability is no longer active");
    }
    return authorization;
  };
  const bindingAuthorization = resolveAuthorization();
  if (!params.runtimeConfig) {
    return undefined;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.runtimeConfig,
    agentId,
    workspaceDir: params.workspaceDir,
    sessionKey,
    accountId: bindingAuthorization.requesterAccountId ?? route.accountId,
    ...selectMessageActionRequesterIdentity(bindingAuthorization),
  });
  return {
    route,
    send: async ({ text, mediaUrl }) => {
      resolveAuthorization();
      const { runMessageAction } = await loadMessageActionRunner();
      const authorization = resolveAuthorization();
      const cfg = params.getRuntimeConfig?.();
      if (!cfg) {
        throw new Error("current-turn delivery requires an active runtime config");
      }
      const result = await withPluginRuntimeRegistryScope(activeRegistry, () =>
        runMessageAction({
          cfg,
          action: "send",
          params: {
            channel: route.channel,
            target: route.to,
            ...(route.accountId ? { accountId: route.accountId } : {}),
            ...(route.threadId != null ? { threadId: route.threadId } : {}),
            ...(text !== undefined ? { message: text } : {}),
            ...(mediaUrl !== undefined ? { mediaUrl } : {}),
          },
          defaultAccountId: route.accountId,
          ...selectMessageActionRequesterIdentity(authorization),
          messageActionAuthorization: {
            requesterAccountId: authorization.requesterAccountId,
            requesterSenderId: authorization.requesterSenderId,
            toolContext: authorization.toolContext,
          },
          senderIsOwner: params.senderIsOwner,
          conversationReadOrigin: params.conversationReadOrigin,
          toolContext: authorization.toolContext,
          sessionKey,
          sessionId: params.sessionId,
          runId,
          agentId,
          mediaAccess,
          onPlatformSendDispatch: async () => {
            resolveAuthorization();
          },
          forceCoreDelivery: true,
          skipQueue: true,
          dryRun: false,
        }),
      );
      const projected = projectCurrentTurnDeliveryResult(result, route);
      try {
        resolveAuthorization();
      } catch (error) {
        if (projected.status === "sent" || projected.sentBeforeError) {
          throw Object.assign(
            error instanceof Error ? error : new Error(formatErrorMessage(error)),
            { sentBeforeError: true },
          );
        }
        throw error;
      }
      return projected;
    },
  };
}
export function createCurrentTurnDeliveryTool(delivery: CurrentTurnDelivery): AnyAgentTool {
  let consumed = false;
  return {
    name: "send_current_reply",
    label: "Send current reply",
    description: "Send one reply to the host-selected current conversation.",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1 }),
        mediaUrl: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    outputSchema,
    execute: async (_toolCallId, args) => {
      const input = asToolParamsRecord(args);
      const text = readToolStringParam(input, "text", { required: true });
      const mediaUrl = readToolStringParam(input, "mediaUrl");
      if (consumed) {
        throw new ToolInputError("current-turn delivery authority has already been consumed");
      }
      consumed = true;
      try {
        return jsonResult(await delivery.send({ text, mediaUrl }));
      } catch (error) {
        const sentBeforeError = asOptionalRecord(error)?.sentBeforeError === true;
        return jsonResult({
          status: sentBeforeError ? "partial_failed" : "failed",
          channel: delivery.route.channel,
          to: delivery.route.to,
          error: formatErrorMessage(error),
          ...(sentBeforeError ? { sentBeforeError: true } : {}),
        });
      }
    },
  };
}
