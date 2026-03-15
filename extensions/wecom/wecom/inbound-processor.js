import {
  extractGroupMessageContent,
  generateAgentId,
  getDynamicAgentConfig,
  shouldTriggerGroupResponse,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import {
  checkCommandAllowlist,
  getCommandConfig,
  isHighPriorityCommand,
  isWecomAdmin,
} from "./commands.js";
import { THINKING_PLACEHOLDER } from "./constants.js";
import { downloadAndDecryptImage, downloadWecomFile, guessMimeType } from "./media.js";
import { deliverWecomReply } from "./outbound-delivery.js";
import {
  dispatchLocks,
  getRuntime,
  messageBuffers,
  responseUrls,
  streamContext,
  streamMeta,
} from "./state.js";
import { handleStreamError, registerActiveStream, unregisterActiveStream } from "./stream-utils.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";

/**
 * Flush the debounce buffer for a given streamKey.
 * Merges buffered messages into a single dispatch call.
 * The first message's stream receives the LLM response.
 * Subsequent streams get "消息已合并到第一条回复" and finish immediately.
 */
export function flushMessageBuffer(streamKey, target) {
  const buffer = messageBuffers.get(streamKey);
  if (!buffer) {
    return;
  }
  messageBuffers.delete(streamKey);

  const { messages, streamIds } = buffer;
  const primaryStreamId = streamIds[0];
  const primaryMsg = messages[0];

  // Merge content from all buffered messages.
  if (messages.length > 1) {
    const mergedContent = messages
      .map((m) => m.content || "")
      .filter(Boolean)
      .join("\n");
    primaryMsg.content = mergedContent;

    // Merge image attachments.
    const allImageUrls = messages.flatMap((m) => m.imageUrls || []);
    if (allImageUrls.length > 0) {
      primaryMsg.imageUrls = allImageUrls;
    }
    const singleImages = messages.map((m) => m.imageUrl).filter(Boolean);
    if (singleImages.length > 0 && !primaryMsg.imageUrl) {
      primaryMsg.imageUrl = singleImages[0];
      if (singleImages.length > 1) {
        primaryMsg.imageUrls = [...(primaryMsg.imageUrls || []), ...singleImages.slice(1)];
      }
    }

    // Finish extra streams with merge notice.
    for (let i = 1; i < streamIds.length; i++) {
      const extraStreamId = streamIds[i];
      streamManager.replaceIfPlaceholder(
        extraStreamId,
        "消息已合并到第一条回复中。",
        THINKING_PLACEHOLDER,
      );
      streamManager
        .finishStream(extraStreamId)
        .then(() => {
          unregisterActiveStream(streamKey, extraStreamId);
        })
        .catch((err) => {
          logger.error("Failed to finish extra stream", {
            extraStreamId,
            error: err.message,
          });
        });
    }

    logger.info("WeCom: flushing merged messages", {
      streamKey,
      count: messages.length,
      primaryStreamId,
      mergedContentPreview: mergedContent.substring(0, 60),
    });
  } else {
    logger.info("WeCom: flushing single message", {
      streamKey,
      primaryStreamId,
    });
  }

  // Dispatch the merged message.
  processInboundMessage({
    message: primaryMsg,
    streamId: primaryStreamId,
    timestamp: buffer.timestamp,
    nonce: buffer.nonce,
    account: target.account,
    config: target.config,
  }).catch(async (err) => {
    logger.error("WeCom message processing failed", { error: err.message });
    await handleStreamError(primaryStreamId, streamKey, "处理消息时出错，请稍后再试。");
  });
}

export async function processInboundMessage({
  message,
  streamId,
  timestamp: _timestamp,
  nonce: _nonce,
  account,
  config,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const msgType = message.msgType || "text";
  const imageUrl = message.imageUrl || "";
  const imageUrls = message.imageUrls || [];
  const fileUrl = message.fileUrl || "";
  const fileName = message.fileName || "";
  const rawContent = message.content || "";
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  const isGroupChat = chatType === "group" && chatId;

  // Use chat id for group sessions and sender id for direct messages.
  const peerId = isGroupChat ? chatId : senderId;
  const peerKind = isGroupChat ? "group" : "dm";
  const conversationId = isGroupChat ? `wecom:group:${chatId}` : `wecom:${senderId}`;

  // Track active stream by chat context for outbound adapter callbacks.
  // Prefix with accountId so multi-account setups don't share debounce buffers
  // or response_url state across accounts for the same user/group id.
  const accountPrefix = account.accountId ? `${account.accountId}:` : "";
  const streamKey = `${accountPrefix}${isGroupChat ? chatId : senderId}`;
  if (streamId) {
    registerActiveStream(streamKey, streamId);
    // Persist sender context for this stream so outbound media fallbacks
    // can still DM the real user in group conversations.
    const prevMeta = streamMeta.get(streamId) || {};
    streamMeta.set(streamId, {
      ...prevMeta,
      senderId,
      streamKey,
      chatId,
      chatType,
      mainResponseDone: false,
      createdAt: prevMeta.createdAt ?? Date.now(),
    });
  }

  // Save response_url for fallback delivery after stream closes.
  // response_url is valid for 1 hour and can be used only once.
  if (message.responseUrl && message.responseUrl.trim()) {
    responseUrls.set(streamKey, {
      url: message.responseUrl,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
      used: false,
    });
    logger.debug("WeCom: saved response_url for fallback", { streamKey });
  }

  // Apply group mention gating rules.
  let rawBody = rawContent;
  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(rawContent, account.config)) {
      logger.debug("WeCom: group message ignored (no mention)", {
        chatId,
        senderId,
      });
      if (streamId) {
        streamManager.replaceIfPlaceholder(streamId, "请@提及我以获取回复。", THINKING_PLACEHOLDER);
        await streamManager.finishStream(streamId);
        unregisterActiveStream(streamKey, streamId);
      }
      return;
    }
    // Strip mention markers from the effective prompt.
    rawBody = extractGroupMessageContent(rawContent, account.config);
  }

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });

  // ── Quoted message context ────────────────────────────────────────
  // When the user replies to (quotes) a previous message, prepend the
  // quoted content so the LLM sees the full conversational context.
  const quote = message.quote;
  if (quote && quote.content) {
    const quoteLabel = quote.msgType === "image" ? "[引用图片]" : `> ${quote.content}`;
    rawBody = `${quoteLabel}\n\n${rawBody}`;
    logger.debug("WeCom: prepended quoted message context", {
      quoteType: quote.msgType,
      quotePreview: quote.content.substring(0, 60),
    });
  }

  // Skip empty messages, but allow image/mixed/file messages.
  if (!rawBody.trim() && !imageUrl && imageUrls.length === 0 && !fileUrl) {
    logger.debug("WeCom: empty message, skipping", { msgType });
    if (streamId) {
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  // ========================================================================
  // Command allowlist enforcement
  // Admins bypass the allowlist entirely.
  // ========================================================================
  const senderIsAdmin = isWecomAdmin(senderId, account.config);
  const commandCheck = checkCommandAllowlist(rawBody, account.config);

  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    // Return block message when command is outside the allowlist.
    const cmdConfig = getCommandConfig(account.config);
    logger.warn("WeCom: blocked command", {
      command: commandCheck.command,
      from: senderId,
      chatType: peerKind,
    });

    // Send blocked-command response through the same stream.
    if (streamId) {
      streamManager.replaceIfPlaceholder(streamId, cmdConfig.blockMessage, THINKING_PLACEHOLDER);
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  if (commandCheck.isCommand && !commandCheck.allowed && senderIsAdmin) {
    logger.info("WeCom: admin bypassed command allowlist", {
      command: commandCheck.command,
      from: senderId,
    });
  }

  logger.info("WeCom processing message", {
    from: senderId,
    chatType: peerKind,
    peerId,
    content: rawBody.substring(0, 50),
    streamId,
    isCommand: commandCheck.isCommand,
    command: commandCheck.command,
  });

  const highPriorityCommand = commandCheck.isCommand && isHighPriorityCommand(commandCheck.command);

  // ========================================================================
  // Dynamic agent routing
  // Admins also use dynamic agents; admin flag only affects command allowlist.
  // ========================================================================
  const dynamicConfig = getDynamicAgentConfig(account.config);

  // Compute deterministic agent target for this conversation.
  const targetAgentId =
    dynamicConfig.enabled && shouldUseDynamicAgent({ chatType: peerKind, config: account.config })
      ? generateAgentId(peerKind, peerId, account.accountId)
      : null;

  if (targetAgentId) {
    await ensureDynamicAgentListed(targetAgentId);
    logger.debug("Using dynamic agent", {
      agentId: targetAgentId,
      chatType: peerKind,
      peerId,
    });
  } else if (senderIsAdmin) {
    logger.debug(
      "Admin user, dynamic agent disabled for this chat type; falling back to default route",
      {
        senderId,
        chatType: peerKind,
      },
    );
  }

  // ========================================================================
  // Resolve route and override with dynamic agent when enabled
  // ========================================================================
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  // Override default route with deterministic dynamic agent session key.
  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Prefix sender id in group contexts so attribution stays explicit.
  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const body = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build context payload with optional image attachment.
  const ctxBase = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wecom:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `Group ${chatId}` : senderId,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  };

  // Download, decrypt, and attach media when present.
  const allImageUrls = imageUrl ? [imageUrl] : imageUrls;

  if (allImageUrls.length > 0) {
    const mediaPaths = [];
    const mediaTypes = [];
    const fallbackUrls = [];

    for (const url of allImageUrls) {
      try {
        const result = await downloadAndDecryptImage(url, account.encodingAesKey, account.token);
        mediaPaths.push(result.localPath);
        mediaTypes.push(result.mimeType);
      } catch (e) {
        logger.warn("Image decryption failed, using URL fallback", {
          error: e.message,
          url: url.substring(0, 80),
        });
        fallbackUrls.push(url);
        mediaTypes.push("image/jpeg");
      }
    }

    if (mediaPaths.length > 0) {
      ctxBase.MediaPaths = mediaPaths;
    }
    if (fallbackUrls.length > 0) {
      ctxBase.MediaUrls = fallbackUrls;
    }
    ctxBase.MediaTypes = mediaTypes;

    logger.info("Image attachments prepared", {
      decrypted: mediaPaths.length,
      fallback: fallbackUrls.length,
    });

    // For image-only messages (no text), set a placeholder body.
    if (!rawBody.trim()) {
      const count = allImageUrls.length;
      ctxBase.Body = count > 1 ? `[用户发送了${count}张图片]` : "[用户发送了一张图片]";
      ctxBase.RawBody = "[图片]";
      ctxBase.CommandBody = "";
    }
  }

  // Handle file attachment.
  if (fileUrl) {
    try {
      const { localPath: localFilePath, effectiveFileName } = await downloadWecomFile(
        fileUrl,
        fileName,
        account.encodingAesKey,
        account.token,
      );
      ctxBase.MediaPaths = [...(ctxBase.MediaPaths || []), localFilePath];
      ctxBase.MediaTypes = [...(ctxBase.MediaTypes || []), guessMimeType(effectiveFileName)];
      logger.info("File attachment prepared", {
        path: localFilePath,
        name: effectiveFileName,
      });
    } catch (e) {
      logger.warn("File download failed", { error: e.message });
      // Inform the agent about the file via text.
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      if (!rawBody.trim()) {
        ctxBase.Body = `[用户发送了文件] ${label}`;
        ctxBase.RawBody = label;
        ctxBase.CommandBody = "";
      }
    }
    if (!rawBody.trim() && !ctxBase.Body) {
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      ctxBase.Body = `[用户发送了文件] ${label}`;
      ctxBase.RawBody = label;
      ctxBase.CommandBody = "";
    }
  }

  const ctxPayload = core.reply.finalizeInboundContext(ctxBase);

  // Record session meta
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("WeCom: failed updating session meta", {
        error: err.message,
      });
    });

  const runDispatch = async () => {
    // --- Stream close coordination ---
    // dispatchReplyWithBufferedBlockDispatcher may return before the LLM
    // actually processes the message (e.g. when the session lane is busy and
    // the message is queued).  We therefore track two signals:
    //   1. dispatchDone  – the await on the dispatcher has resolved.
    //   2. hadDelivery   – at least one deliver callback has fired.
    // We only schedule a stream-close timer when BOTH are true, and we
    // reset the timer on every new delivery so the stream stays open while
    // content keeps arriving.
    let dispatchDone = false;
    let hadDelivery = false;
    let closeTimer = null;

    const scheduleStreamClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(async () => {
        const s = streamManager.getStream(streamId);
        if (s && !s.finished) {
          logger.info("WeCom: finishing stream after dispatch complete", {
            streamId,
          });
          try {
            await streamManager.finishStream(streamId);
          } catch (err) {
            logger.error("WeCom: failed to finish stream post-dispatch", {
              streamId,
              error: err.message,
            });
          }
          unregisterActiveStream(streamKey, streamId);
        }
      }, 3000); // 3s grace after last delivery
    };

    // Dispatch reply with AI processing.
    // Wrap in streamContext so outbound adapters resolve the correct stream.
    await streamContext.run(
      {
        streamId,
        streamKey,
        senderId,
        agentId: route.agentId,
        accountId: account.accountId,
      },
      async () => {
        await core.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          // Force block streaming for WeCom so incremental content can be emitted
          // during long LLM runs instead of waiting for final completion.
          replyOptions: {
            disableBlockStreaming: false,
          },
          dispatcherOptions: {
            deliver: async (payload, info) => {
              hadDelivery = true;

              logger.info("Dispatcher deliver called", {
                kind: info.kind,
                hasText: !!(payload.text && payload.text.trim()),
                hasMediaUrl: !!(
                  payload.mediaUrl ||
                  (payload.mediaUrls && payload.mediaUrls.length)
                ),
                textPreview: (payload.text || "").substring(0, 50),
              });

              try {
                await deliverWecomReply({
                  payload,
                  // senderId: actual user id (used for Agent API DM/file delivery)
                  senderId,
                  // responseKey: chat routing key (group uses chatId, dm uses userid)
                  responseKey: streamKey,
                  streamId,
                  agentId: route.agentId,
                });
              } catch (deliverErr) {
                logger.error("WeCom: deliverWecomReply threw, continuing to finalize stream", {
                  streamId,
                  error: deliverErr.message,
                });
              }

              // Mark stream meta when main response is done.
              if (streamId && (info.kind === "final" || info.kind === "block")) {
                const prevMeta = streamMeta.get(streamId) || {};
                streamMeta.set(streamId, {
                  ...prevMeta,
                  mainResponseDone: true,
                  doneAt: Date.now(),
                });
              }

              // Schedule / reset stream close timer if dispatch already returned.
              if (streamId && dispatchDone) {
                scheduleStreamClose();
              }
            },
            onError: async (err, info) => {
              logger.error("WeCom reply failed", {
                error: err.message,
                kind: info.kind,
              });
              await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
            },
          },
        });
      },
    );

    // Dispatch returned.
    dispatchDone = true;

    if (streamId) {
      const stream = streamManager.getStream(streamId);
      if (!stream || stream.finished) {
        unregisterActiveStream(streamKey, streamId);
      } else if (hadDelivery) {
        // Normal case: content was already delivered, close after grace period.
        scheduleStreamClose();
      }
      // If !hadDelivery, the message was queued and is not yet processed.
      // The deliver callback will fire later and schedule the close (since
      // dispatchDone is now true).  The existing stream GC handles the edge
      // case where no delivery ever arrives.
    }
  };

  if (highPriorityCommand) {
    logger.info("WeCom: high-priority command bypassing dispatch queue", {
      streamKey,
      streamId,
      command: commandCheck.command,
    });
    try {
      await runDispatch();
    } catch (err) {
      logger.error("WeCom dispatch chain error", {
        streamId,
        streamKey,
        error: err.message,
      });
      await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
    }
    return;
  }

  // Serialize non-priority dispatches per user/group.
  const prevLock = dispatchLocks.get(streamKey) ?? Promise.resolve();
  const currentDispatch = prevLock.then(runDispatch).catch(async (err) => {
    logger.error("WeCom dispatch chain error", {
      streamId,
      streamKey,
      error: err.message,
    });
    await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
  });

  dispatchLocks.set(streamKey, currentDispatch);
  await currentDispatch;
  if (dispatchLocks.get(streamKey) === currentDispatch) {
    dispatchLocks.delete(streamKey);
  }
}
