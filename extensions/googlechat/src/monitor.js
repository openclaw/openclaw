import {
  createWebhookInFlightLimiter,
  createReplyPrefixOptions,
  registerWebhookTargetWithPluginRoute,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveWebhookPath
} from "openclaw/plugin-sdk/googlechat";
import {
  downloadGoogleChatMedia,
  deleteGoogleChatMessage,
  sendGoogleChatMessage,
  updateGoogleChatMessage
} from "./api.js";
import { applyGoogleChatInboundAccessPolicy, isSenderAllowed } from "./monitor-access.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import { getGoogleChatRuntime } from "./runtime.js";
const webhookTargets = /* @__PURE__ */ new Map();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
  webhookTargets,
  webhookInFlightLimiter,
  processEvent: async (event, target) => {
    await processGoogleChatEvent(event, target);
  }
});
function logVerbose(core, runtime, message) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}
function registerGoogleChatWebhookTarget(target) {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "googlechat",
      source: "googlechat-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleGoogleChatWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      }
    }
  }).unregister;
}
function normalizeAudienceType(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "app-url" || normalized === "app_url" || normalized === "app") {
    return "app-url";
  }
  if (normalized === "project-number" || normalized === "project_number" || normalized === "project") {
    return "project-number";
  }
  return void 0;
}
async function handleGoogleChatWebhookRequest(req, res) {
  return await googleChatWebhookRequestHandler(req, res);
}
async function processGoogleChatEvent(event, target) {
  const eventType = event.type ?? event.eventType;
  if (eventType !== "MESSAGE") {
    return;
  }
  if (!event.message || !event.space) {
    return;
  }
  await processMessageWithPipeline({
    event,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
    mediaMaxMb: target.mediaMaxMb
  });
}
function resolveBotDisplayName(params) {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) {
    return accountName.trim();
  }
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (agent?.name?.trim()) {
    return agent.name.trim();
  }
  return "OpenClaw";
}
async function processMessageWithPipeline(params) {
  const { event, account, config, runtime, core, statusSink, mediaMaxMb } = params;
  const space = event.space;
  const message = event.message;
  if (!space || !message) {
    return;
  }
  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const spaceType = (space.type ?? "").toUpperCase();
  const isGroup = spaceType !== "DM";
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email ?? void 0;
  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (sender?.type?.toUpperCase() === "BOT") {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId === "users/app") {
      logVerbose(core, runtime, "skip app-authored message");
      return;
    }
  }
  const messageText = (message.argumentText ?? message.text ?? "").trim();
  const attachments = message.attachment ?? [];
  const hasMedia = attachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }
  const access = await applyGoogleChatInboundAccessPolicy({
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    statusSink,
    logVerbose: (message2) => logVerbose(core, runtime, message2)
  });
  if (!access.ok) {
    return;
  }
  const { commandAuthorized, effectiveWasMentioned, groupSystemPrompt } = access;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: spaceId
    },
    runtime: core.channel,
    sessionStore: config.session?.store
  });
  let mediaPath;
  let mediaType;
  if (attachments.length > 0) {
    const first = attachments[0];
    const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
    if (attachmentData) {
      mediaPath = attachmentData.path;
      mediaType = attachmentData.contentType;
    }
  }
  const fromLabel = isGroup ? space.displayName || `space:${spaceId}` : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: event.eventTime ? Date.parse(event.eventTime) : void 0,
    body: rawBody
  });
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `googlechat:${senderId}`,
    To: `googlechat:${spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || void 0,
    SenderId: senderId,
    SenderUsername: senderEmail,
    WasMentioned: isGroup ? effectiveWasMentioned : void 0,
    CommandAuthorized: commandAuthorized,
    Provider: "googlechat",
    Surface: "googlechat",
    MessageSid: message.name,
    MessageSidFull: message.name,
    ReplyToId: message.thread?.name,
    ReplyToIdFull: message.thread?.name,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    GroupSpace: isGroup ? space.displayName ?? void 0 : void 0,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : void 0,
    OriginatingChannel: "googlechat",
    OriginatingTo: `googlechat:${spaceId}`
  });
  void core.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload
  }).catch((err) => {
    runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
  });
  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`
    );
    typingIndicator = "message";
  }
  let typingMessageName;
  if (typingIndicator === "message") {
    try {
      const botName = resolveBotDisplayName({
        accountName: account.config.name,
        agentId: route.agentId,
        config
      });
      const result = await sendGoogleChatMessage({
        account,
        space: spaceId,
        text: `_${botName} is typing..._`,
        thread: message.thread?.name
      });
      typingMessageName = result?.messageName;
    } catch (err) {
      runtime.error?.(`Failed sending typing message: ${String(err)}`);
    }
  }
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "googlechat",
    accountId: route.accountId
  });
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverGoogleChatReply({
          payload,
          account,
          spaceId,
          runtime,
          core,
          config,
          statusSink,
          typingMessageName
        });
        typingMessageName = void 0;
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`
        );
      }
    },
    replyOptions: {
      onModelSelected
    }
  });
}
async function downloadAttachment(attachment, account, mediaMaxMb, core) {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, resourceName, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName
  );
  return { path: saved.path, contentType: saved.contentType };
}
async function deliverGoogleChatReply(params) {
  const { payload, account, spaceId, runtime, core, config, statusSink, typingMessageName } = params;
  const mediaList = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
  if (mediaList.length > 0) {
    let suppressCaption = false;
    if (typingMessageName) {
      try {
        await deleteGoogleChatMessage({
          account,
          messageName: typingMessageName
        });
      } catch (err) {
        runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
        const fallbackText = payload.text?.trim() ? payload.text : mediaList.length > 1 ? "Sent attachments." : "Sent attachment.";
        try {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: fallbackText
          });
          suppressCaption = Boolean(payload.text?.trim());
        } catch (updateErr) {
          runtime.error?.(`Google Chat typing update failed: ${String(updateErr)}`);
        }
      }
    }
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first && !suppressCaption ? payload.text : void 0;
      first = false;
      try {
        const loaded = await core.channel.media.fetchRemoteMedia({
          url: mediaUrl,
          maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024
        });
        const upload = await uploadAttachmentForReply({
          account,
          spaceId,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
          filename: loaded.fileName ?? "attachment"
        });
        if (!upload.attachmentUploadToken) {
          throw new Error("missing attachment upload token");
        }
        await sendGoogleChatMessage({
          account,
          space: spaceId,
          text: caption,
          thread: payload.replyToId,
          attachments: [
            { attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName }
          ]
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat attachment send failed: ${String(err)}`);
      }
    }
    return;
  }
  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 4e3;
    const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        if (i === 0 && typingMessageName) {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: chunk
          });
        } else {
          await sendGoogleChatMessage({
            account,
            space: spaceId,
            text: chunk,
            thread: payload.replyToId
          });
        }
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat message send failed: ${String(err)}`);
      }
    }
  }
}
async function uploadAttachmentForReply(params) {
  const { account, spaceId, buffer, contentType, filename } = params;
  const { uploadGoogleChatAttachment } = await import("./api.js");
  return await uploadGoogleChatAttachment({
    account,
    space: spaceId,
    filename,
    buffer,
    contentType
  });
}
function monitorGoogleChatProvider(options) {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveWebhookPath({
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
    defaultPath: "/googlechat"
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {
    };
  }
  const audienceType = normalizeAudienceType(options.account.config.audienceType);
  const audience = options.account.config.audience?.trim();
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;
  const unregisterTarget = registerGoogleChatWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb
  });
  return () => {
    unregisterTarget();
  };
}
async function startGoogleChatMonitor(params) {
  return monitorGoogleChatProvider(params);
}
function resolveGoogleChatWebhookPath(params) {
  return resolveWebhookPath({
    webhookPath: params.account.config.webhookPath,
    webhookUrl: params.account.config.webhookUrl,
    defaultPath: "/googlechat"
  }) ?? "/googlechat";
}
function computeGoogleChatMediaMaxMb(params) {
  return params.account.config.mediaMaxMb ?? 20;
}
export {
  computeGoogleChatMediaMaxMb,
  handleGoogleChatWebhookRequest,
  isSenderAllowed,
  monitorGoogleChatProvider,
  registerGoogleChatWebhookTarget,
  resolveGoogleChatWebhookPath,
  startGoogleChatMonitor
};
