import type { AllMiddlewareArgs } from "@slack/bolt";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  dispatchSlackPluginInteractiveHandler,
  type SlackInteractiveHandlerResult,
} from "../../interactive-dispatch.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import type { SlackMessageEvent } from "../../types.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackMonitorEventScope } from "../event-scope.js";
import {
  captureSlackInteractionEventRoute,
  enqueueSlackInteractionEvent,
} from "./interaction-event.js";
import { summarizeSlackViewState } from "./modal-input-summary.js";

type SlackModalBody = {
  user?: { id?: string };
  trigger_id?: string;
  view?: {
    id?: string;
    callback_id?: string;
    private_metadata?: string;
    root_view_id?: string;
    previous_view_id?: string;
    external_id?: string;
    hash?: string;
    state?: { values?: unknown };
  };
  is_cleared?: boolean;
};

type SlackModalInteractionKind = "view_submission" | "view_closed";
type SlackModalEventHandlerArgs = { ack: () => Promise<void>; body: unknown } & Pick<
  AllMiddlewareArgs,
  "context" | "client"
>;

const OPENCLAW_MODAL_CALLBACK_PREFIX = "openclaw:";

function resolveSlackPluginSystemEventPayload(
  result: SlackInteractiveHandlerResult,
): Record<string, unknown> | undefined {
  const systemEvent = result?.systemEvent;
  if (!systemEvent) {
    return undefined;
  }
  const output = {
    ...(systemEvent.summary?.trim() ? { summary: systemEvent.summary } : {}),
    ...(systemEvent.reference?.trim() ? { reference: systemEvent.reference } : {}),
    ...(systemEvent.data ? { data: systemEvent.data } : {}),
  };
  return Object.keys(output).length > 0 ? output : undefined;
}

export function registerModalLifecycleHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  interactionType: SlackModalInteractionKind;
}) {
  params.ctx.app.view(
    { callback_id: /.*/, type: params.interactionType },
    async (args: SlackModalEventHandlerArgs) => {
      const { ack, body } = args;
      const typedBody = body as SlackModalBody;
      const metadata = parseSlackModalPrivateMetadata(typedBody.view?.private_metadata);
      if (
        !typedBody.view?.callback_id?.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX) &&
        !metadata.pluginInteractiveData
      ) {
        return;
      }
      await ack();
      const eventScope = resolveSlackMonitorEventScope({
        ctx: params.ctx,
        body,
        context: args.context,
        client: args.client,
        onDrop: (reason) =>
          params.ctx.runtime.log?.(`slack:interaction drop ${params.interactionType} ${reason}`),
      });
      if (eventScope === null) {
        return;
      }
      if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
        params.ctx.runtime.log?.(
          `slack:interaction drop ${params.interactionType} payload (mismatched app/team)`,
        );
        return;
      }
      params.trackEvent?.();
      const runtimeCtx = await params.ctx.readRuntimeContext();
      const teamId = args.context.teamId;
      const interactionType = params.interactionType;
      const callbackId = typedBody.view?.callback_id ?? "unknown";
      const userId = typedBody.user?.id ?? "unknown";
      const viewId = typedBody.view?.id;
      const inputs = summarizeSlackViewState(typedBody.view?.state?.values);
      const resolveModalSessionRouting = async (): Promise<{
        agentId: string;
        sessionKey: string;
        channelId?: string;
        channelType?: string;
      }> => {
        const metadataAgentId = metadata.sessionKey
          ? resolveAgentIdFromSessionKey(metadata.sessionKey)
          : undefined;
        if (metadata.sessionKey && metadataAgentId && !eventScope) {
          return {
            agentId: metadataAgentId,
            sessionKey: metadata.sessionKey,
            channelId: metadata.channelId,
            channelType: metadata.channelType,
          };
        }
        const routing = {
          ...(await runtimeCtx.resolveSlackSystemEventRoute({
            ...(metadata.channelId
              ? { channelId: metadata.channelId, channelType: metadata.channelType }
              : { channelType: "im" }),
            senderId: userId,
            eventScope,
          })),
          ...(metadata.channelId
            ? { channelId: metadata.channelId, channelType: metadata.channelType }
            : { channelType: eventScope ? "im" : undefined }),
        };
        if (
          metadata.sessionKey &&
          (metadata.sessionKey === routing.sessionKey ||
            metadata.sessionKey.startsWith(`${routing.sessionKey}:thread:`))
        ) {
          // Preserve an exact thread only after its base is bound to this Enterprise workspace.
          return { ...routing, sessionKey: metadata.sessionKey };
        }
        return routing;
      };

      const sessionRouting = await resolveModalSessionRouting();
      const route = await captureSlackInteractionEventRoute(sessionRouting, runtimeCtx.runtime.log);
      if (!runtimeCtx.isRuntimePolicyCurrent()) {
        return;
      }
      const stateValues = typedBody.view?.state?.values;
      const payload = {
        actionId: `view:${callbackId}`,
        callbackId,
        viewId,
        userId,
        teamId,
        rootViewId: typedBody.view?.root_view_id,
        previousViewId: typedBody.view?.previous_view_id,
        externalId: typedBody.view?.external_id,
        viewHash: typedBody.view?.hash,
        isStackedView: Boolean(typedBody.view?.previous_view_id),
        privateMetadata: typedBody.view?.private_metadata,
        routedChannelId: sessionRouting.channelId,
        routedChannelType: sessionRouting.channelType,
        inputs,
      };
      const pluginInteractiveData =
        metadata.pluginInteractiveData ||
        (callbackId.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX)
          ? callbackId.slice(OPENCLAW_MODAL_CALLBACK_PREFIX.length).trim() || undefined
          : undefined);
      const isViewClosed = interactionType === "view_closed";
      const isCleared = typedBody.is_cleared === true;
      const eventPayload = {
        interactionType,
        ...payload,
        ...(isViewClosed ? { isCleared } : {}),
      };

      if (isViewClosed) {
        runtimeCtx.runtime.log?.(
          `slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`,
        );
      } else {
        runtimeCtx.runtime.log?.(
          `slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`,
        );
      }

      const dispatchPlugin = async (
        isAuthorizedSender: boolean,
        channelType?: NonNullable<SlackMessageEvent["channel_type"]>,
      ) => {
        try {
          if (!pluginInteractiveData) {
            return undefined;
          }
          if (!runtimeCtx.isRuntimePolicyCurrent()) {
            return undefined;
          }

          const interactionId = [
            interactionType,
            payload.callbackId,
            payload.viewId,
            payload.userId,
          ]
            .filter(Boolean)
            .join(":");
          const result = await dispatchSlackPluginInteractiveHandler({
            data: pluginInteractiveData,
            interactionId,
            teamId: eventScope?.teamId,
            channelType,
            ctx: {
              accountId: runtimeCtx.accountId,
              interactionId,
              conversationId: sessionRouting.channelId ?? "",
              parentConversationId: undefined,
              threadId: undefined,
              senderId: payload.userId,
              senderUsername: undefined,
              auth: { isAuthorizedSender },
              interaction: {
                kind: interactionType,
                callbackId: payload.callbackId,
                viewId: payload.viewId,
                rootViewId: payload.rootViewId,
                previousViewId: payload.previousViewId,
                externalId: payload.externalId,
                isStackedView: payload.isStackedView,
                isCleared: isViewClosed ? typedBody.is_cleared === true : undefined,
                inputs: payload.inputs,
                stateValues,
                triggerId: typedBody.trigger_id,
              },
            },
            respond: {
              acknowledge: async () => {},
              reply: async () => {},
              followUp: async () => {},
              editMessage: async () => {},
            },
          });
          return {
            ...result,
            namespace: result.matched ? pluginInteractiveData.split(":", 1)[0] : undefined,
            systemEvent: result.matched
              ? resolveSlackPluginSystemEventPayload(result.result)
              : undefined,
          };
        } catch (error) {
          runtimeCtx.runtime.log?.(
            `slack:interaction modal plugin dispatch failed callback=${callbackId} error=${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      };

      if (!metadata.userId) {
        if (pluginInteractiveData) {
          await dispatchPlugin(false);
        }
        runtimeCtx.runtime.log?.(
          `slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`,
        );
        return;
      }

      const auth = await authorizeSlackSystemEventSender({
        ctx: runtimeCtx,
        eventScope,
        senderId: userId,
        channelId: sessionRouting.channelId,
        channelType: sessionRouting.channelType,
        expectedSenderId: metadata.userId,
        interactiveEvent: true,
      });
      if (!auth.allowed) {
        runtimeCtx.runtime.log?.(
          `slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`,
        );
        return;
      }

      const pluginDispatch = await dispatchPlugin(auth.allowed, auth.channelType);

      const pluginEventFields =
        pluginDispatch?.matched === true
          ? {
              pluginHandled: pluginDispatch.handled,
              pluginNamespace: pluginDispatch.namespace,
              pluginDuplicate: pluginDispatch.duplicate || undefined,
              pluginSystemEvent: pluginDispatch.systemEvent,
            }
          : {};

      const targetKind = auth.channelType === "im" ? "user" : "channel";
      const targetId = targetKind === "user" ? userId : sessionRouting.channelId;
      const deferredTarget = targetId
        ? resolveSlackDeferredActionTarget({
            eventScope,
            kind: targetKind,
            id: targetId,
          })
        : undefined;

      if (!route || !runtimeCtx.isRuntimePolicyCurrent()) {
        return;
      }
      await enqueueSlackInteractionEvent(
        { ...eventPayload, ...pluginEventFields },
        route,
        {
          contextKey: [
            isViewClosed ? "slack:interaction:view-closed" : "slack:interaction:view",
            teamId,
            callbackId,
            viewId,
            userId,
          ]
            .filter(Boolean)
            .join(":"),
          deliveryContext: {
            channel: "slack",
            ...(deferredTarget ? { to: deferredTarget.target } : {}),
            accountId: runtimeCtx.accountId,
          },
        },
        runtimeCtx.runtime.log,
      );
    },
  );
}
