import type { AllMiddlewareArgs } from "@slack/bolt";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { dispatchSlackPluginInteractiveHandler } from "../../interactive-dispatch.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackMonitorEventScope, type SlackEventScope } from "../event-scope.js";
import { enqueueSlackInteractionEvent } from "./interaction-event.js";
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

function resolveSlackModalPluginInteractiveData(params: {
  callbackId: string;
  metadata: ReturnType<typeof parseSlackModalPrivateMetadata>;
}): string | undefined {
  const metadataData = params.metadata.pluginInteractiveData?.trim();
  if (metadataData) {
    return metadataData;
  }
  if (!params.callbackId.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX)) {
    return undefined;
  }
  const callbackData = params.callbackId.slice(OPENCLAW_MODAL_CALLBACK_PREFIX.length).trim();
  return callbackData || undefined;
}

function shouldHandleSlackModalLifecycleBody(body: unknown): boolean {
  const typed = body as SlackModalBody;
  const callbackId = typed.view?.callback_id ?? "";
  if (callbackId.startsWith(OPENCLAW_MODAL_CALLBACK_PREFIX)) {
    return true;
  }
  const metadata = parseSlackModalPrivateMetadata(typed.view?.private_metadata);
  return Boolean(metadata.pluginInteractiveData?.trim());
}

function resolveSlackPluginSystemEventPayload(
  result: unknown,
): Record<string, unknown> | undefined {
  const systemEvent = asOptionalObjectRecord(asOptionalObjectRecord(result)?.systemEvent);
  if (!systemEvent) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  if (typeof systemEvent.summary === "string" && systemEvent.summary.trim()) {
    output.summary = systemEvent.summary;
  }
  if (typeof systemEvent.reference === "string" && systemEvent.reference.trim()) {
    output.reference = systemEvent.reference;
  }
  if (
    systemEvent.data &&
    typeof systemEvent.data === "object" &&
    !Array.isArray(systemEvent.data)
  ) {
    output.data = systemEvent.data;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

async function resolveModalSessionRouting(params: {
  ctx: SlackMonitorContext;
  metadata: ReturnType<typeof parseSlackModalPrivateMetadata>;
  userId?: string;
  eventScope?: SlackEventScope;
}): Promise<{ agentId: string; sessionKey: string; channelId?: string; channelType?: string }> {
  const metadata = params.metadata;
  const metadataAgentId = metadata.sessionKey
    ? resolveAgentIdFromSessionKey(metadata.sessionKey)
    : undefined;
  if (metadata.sessionKey && metadataAgentId && !params.eventScope) {
    return {
      agentId: metadataAgentId,
      sessionKey: metadata.sessionKey,
      channelId: metadata.channelId,
      channelType: metadata.channelType,
    };
  }
  const routing = {
    ...(await params.ctx.resolveSlackSystemEventRoute({
      ...(metadata.channelId
        ? { channelId: metadata.channelId, channelType: metadata.channelType }
        : { channelType: "im" }),
      senderId: params.userId,
      eventScope: params.eventScope,
    })),
    ...(metadata.channelId
      ? { channelId: metadata.channelId, channelType: metadata.channelType }
      : { channelType: params.eventScope ? "im" : undefined }),
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
}

async function emitSlackModalLifecycleEvent(params: {
  ctx: SlackMonitorContext;
  body: SlackModalBody;
  eventScope?: SlackEventScope;
  teamId?: string;
  interactionType: SlackModalInteractionKind;
}): Promise<void> {
  const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
  const callbackId = params.body.view?.callback_id ?? "unknown";
  const userId = params.body.user?.id ?? "unknown";
  const viewId = params.body.view?.id;
  const inputs = summarizeSlackViewState(params.body.view?.state?.values);
  const sessionRouting = await resolveModalSessionRouting({
    ctx: params.ctx,
    metadata,
    userId,
    eventScope: params.eventScope,
  });
  const stateValues = params.body.view?.state?.values;
  const payload = {
    actionId: `view:${callbackId}`,
    callbackId,
    viewId,
    userId,
    teamId: params.teamId,
    rootViewId: params.body.view?.root_view_id,
    previousViewId: params.body.view?.previous_view_id,
    externalId: params.body.view?.external_id,
    viewHash: params.body.view?.hash,
    isStackedView: Boolean(params.body.view?.previous_view_id),
    privateMetadata: params.body.view?.private_metadata,
    routedChannelId: sessionRouting.channelId,
    routedChannelType: sessionRouting.channelType,
    inputs,
  };
  const pluginInteractiveData = resolveSlackModalPluginInteractiveData({
    callbackId,
    metadata,
  });
  const isViewClosed = params.interactionType === "view_closed";
  const isCleared = params.body.is_cleared === true;
  const eventPayload = {
    interactionType: params.interactionType,
    ...payload,
    ...(isViewClosed ? { isCleared } : {}),
  };

  if (isViewClosed) {
    params.ctx.runtime.log?.(
      `slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`,
    );
  } else {
    params.ctx.runtime.log?.(
      `slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`,
    );
  }

  const dispatchPlugin = async (
    isAuthorizedSender: boolean,
    channelType?: "im" | "mpim" | "channel" | "group",
  ) => {
    try {
      if (!pluginInteractiveData) {
        return undefined;
      }

      const interactionId = [
        params.interactionType,
        payload.callbackId,
        payload.viewId,
        payload.userId,
      ]
        .filter(Boolean)
        .join(":");
      const result = await dispatchSlackPluginInteractiveHandler({
        data: pluginInteractiveData,
        interactionId,
        teamId: params.eventScope?.teamId,
        channelType,
        ctx: {
          accountId: params.ctx.accountId,
          interactionId,
          conversationId: sessionRouting.channelId ?? "",
          parentConversationId: undefined,
          threadId: undefined,
          senderId: payload.userId,
          senderUsername: undefined,
          auth: { isAuthorizedSender },
          interaction: {
            kind: params.interactionType,
            callbackId: payload.callbackId,
            viewId: payload.viewId,
            rootViewId: payload.rootViewId,
            previousViewId: payload.previousViewId,
            externalId: payload.externalId,
            isStackedView: payload.isStackedView,
            isCleared: isViewClosed ? params.body.is_cleared === true : undefined,
            inputs: payload.inputs,
            stateValues,
            triggerId: params.body.trigger_id,
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
      params.ctx.runtime.log?.(
        `slack:interaction modal plugin dispatch failed callback=${callbackId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  if (!metadata.userId) {
    if (pluginInteractiveData) {
      await dispatchPlugin(false);
    }
    params.ctx.runtime.log?.(
      `slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`,
    );
    return;
  }

  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    senderId: userId,
    channelId: sessionRouting.channelId,
    channelType: sessionRouting.channelType,
    expectedSenderId: metadata.userId,
    interactiveEvent: true,
  });
  if (!auth.allowed) {
    params.ctx.runtime.log?.(
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
        eventScope: params.eventScope,
        kind: targetKind,
        id: targetId,
      })
    : undefined;

  enqueueSlackInteractionEvent({ ...eventPayload, ...pluginEventFields }, sessionRouting, {
    contextKey: [
      isViewClosed ? "slack:interaction:view-closed" : "slack:interaction:view",
      params.teamId,
      callbackId,
      viewId,
      userId,
    ]
      .filter(Boolean)
      .join(":"),
    deliveryContext: {
      channel: "slack",
      ...(deferredTarget ? { to: deferredTarget.target } : {}),
      accountId: params.ctx.accountId,
    },
  });
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
      if (!shouldHandleSlackModalLifecycleBody(body)) {
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
      const typedBody = body as SlackModalBody;
      await emitSlackModalLifecycleEvent({
        ctx: await params.ctx.readRuntimeContext(),
        body: typedBody,
        eventScope,
        teamId: args.context.teamId,
        interactionType: params.interactionType,
      });
    },
  );
}
