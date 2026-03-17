import { enqueueSystemEvent } from "../../../../../src/infra/system-events.js";
import { parseSlackModalPrivateMetadata } from "../../modal-metadata.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
function resolveModalSessionRouting(params) {
  const metadata = params.metadata;
  if (metadata.sessionKey) {
    return {
      sessionKey: metadata.sessionKey,
      channelId: metadata.channelId,
      channelType: metadata.channelType
    };
  }
  if (metadata.channelId) {
    return {
      sessionKey: params.ctx.resolveSlackSystemEventSessionKey({
        channelId: metadata.channelId,
        channelType: metadata.channelType,
        senderId: params.userId
      }),
      channelId: metadata.channelId,
      channelType: metadata.channelType
    };
  }
  return {
    sessionKey: params.ctx.resolveSlackSystemEventSessionKey({})
  };
}
function summarizeSlackViewLifecycleContext(view) {
  const rootViewId = view.root_view_id;
  const previousViewId = view.previous_view_id;
  const externalId = view.external_id;
  const viewHash = view.hash;
  return {
    rootViewId,
    previousViewId,
    externalId,
    viewHash,
    isStackedView: Boolean(previousViewId)
  };
}
function resolveSlackModalEventBase(params) {
  const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
  const callbackId = params.body.view?.callback_id ?? "unknown";
  const userId = params.body.user?.id ?? "unknown";
  const viewId = params.body.view?.id;
  const inputs = params.summarizeViewState(params.body.view?.state?.values);
  const sessionRouting = resolveModalSessionRouting({
    ctx: params.ctx,
    metadata,
    userId
  });
  return {
    callbackId,
    userId,
    expectedUserId: metadata.userId,
    viewId,
    sessionRouting,
    payload: {
      actionId: `view:${callbackId}`,
      callbackId,
      viewId,
      userId,
      teamId: params.body.team?.id,
      ...summarizeSlackViewLifecycleContext({
        root_view_id: params.body.view?.root_view_id,
        previous_view_id: params.body.view?.previous_view_id,
        external_id: params.body.view?.external_id,
        hash: params.body.view?.hash
      }),
      privateMetadata: params.body.view?.private_metadata,
      routedChannelId: sessionRouting.channelId,
      routedChannelType: sessionRouting.channelType,
      inputs
    }
  };
}
async function emitSlackModalLifecycleEvent(params) {
  const { callbackId, userId, expectedUserId, viewId, sessionRouting, payload } = resolveSlackModalEventBase({
    ctx: params.ctx,
    body: params.body,
    summarizeViewState: params.summarizeViewState
  });
  const isViewClosed = params.interactionType === "view_closed";
  const isCleared = params.body.is_cleared === true;
  const eventPayload = isViewClosed ? {
    interactionType: params.interactionType,
    ...payload,
    isCleared
  } : {
    interactionType: params.interactionType,
    ...payload
  };
  if (isViewClosed) {
    params.ctx.runtime.log?.(
      `slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`
    );
  } else {
    params.ctx.runtime.log?.(
      `slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`
    );
  }
  if (!expectedUserId) {
    params.ctx.runtime.log?.(
      `slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`
    );
    return;
  }
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    senderId: userId,
    channelId: sessionRouting.channelId,
    channelType: sessionRouting.channelType,
    expectedSenderId: expectedUserId
  });
  if (!auth.allowed) {
    params.ctx.runtime.log?.(
      `slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`
    );
    return;
  }
  enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
    sessionKey: sessionRouting.sessionKey,
    contextKey: [params.contextPrefix, callbackId, viewId, userId].filter(Boolean).join(":")
  });
}
function registerModalLifecycleHandler(params) {
  params.register(params.matcher, async ({ ack, body }) => {
    await ack();
    if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
      params.ctx.runtime.log?.(
        `slack:interaction drop ${params.interactionType} payload (mismatched app/team)`
      );
      return;
    }
    await emitSlackModalLifecycleEvent({
      ctx: params.ctx,
      body,
      interactionType: params.interactionType,
      contextPrefix: params.contextPrefix,
      summarizeViewState: params.summarizeViewState,
      formatSystemEvent: params.formatSystemEvent
    });
  });
}
export {
  emitSlackModalLifecycleEvent,
  registerModalLifecycleHandler
};
