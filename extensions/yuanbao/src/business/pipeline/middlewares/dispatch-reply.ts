/**
 * Middleware: AI reply dispatch.
 *
 * Manually calls recordInboundSession + dispatchReplyWithBufferedBlockDispatcher step by step,
 * so the deliver callback receives info.kind (block/tool/final) to correctly distinguish
 * reply block types and avoid sending tool-call results as plain text.
 */

import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveOutboundMediaUrls,
  normalizeOutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { WS_HEARTBEAT } from "../../../access/ws/types.js";
import { getPluginVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";
import { createReplyHeartbeatController } from "../../outbound/heartbeat.js";
import { runWithTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const dispatchReply: MiddlewareDescriptor = {
  name: "dispatch-reply",
  handler: async (ctx, next) => {
    const {
      core,
      config,
      account,
      ctxPayload,
      route,
      storePath,
      isGroup,
      fromAccount,
      groupCode,
      sender,
      queueSession,
    } = ctx;

    if (!ctxPayload || !route || !storePath || !sender || !queueSession) {
      const missing = [
        !ctxPayload && "ctxPayload",
        !route && "route",
        !storePath && "storePath",
        !sender && "sender",
        !queueSession && "queueSession",
      ].filter(Boolean);
      ctx.log.error("[dispatch-reply] prerequisite middleware not ready", {
        missing: missing.join(", "),
      });
      return;
    }

    // Yuanbao client natively renders Markdown tables, always use 'off'
    const tableMode = "off" as const;

    ctx.log.debug("[dispatch-reply] generating reply", {
      target: isGroup ? `group:${groupCode}` : fromAccount,
    });

    // ⭐ Create heartbeat controller (using real Logger instance instead of noop)
    const heartbeatLog = createLog("heartbeat");
    const heartbeatMeta = {
      ctx: {
        account,
        config,
        core,
        log: {
          ...heartbeatLog,
          verbose: (...a: [string, Record<string, unknown>?]) => heartbeatLog.debug(...a),
        },
        wsClient: ctx.wsClient,
        groupCode,
        abortSignal: ctx.abortSignal,
        statusSink: ctx.statusSink,
      },
      account,
      toAccount: fromAccount,
      groupCode,
    };
    const heartbeat = createReplyHeartbeatController({ meta: heartbeatMeta });

    // Track deliver kind transitions, detect tool-call boundaries
    let prevDeliverKind: string | null = null;
    let hasSentContent = false;

    try {
      // ⭐ Step 1: Record inbound session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          ctx.log.error("[dispatch-reply] recordInboundSession failed", { error: String(err) });
        },
      });

      // ⭐ Step 2: Create reply pipeline
      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: config,
        agentId: route.agentId,
        channel: "yuanbao",
        accountId: account.accountId,
      });

      // ⭐ Step 3: Dispatch reply (deliver callback with info.kind)
      // Wrap with runWithTraceContext to ensure AI request fetch interceptor auto-injects X-Traceparent header
      const doDispatchReply = () =>
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            ...replyPipeline,
            deliver: async (payload: Record<string, unknown>, info: { kind: string }) => {
              if (ctx.abortSignal?.aborted) {
                ctx.log.warn(
                  `[${account.accountId}] reply aborted, stopping subsequent reply blocks`,
                );
                return;
              }

              if (payload.isReasoning) {
                ctx.log.info("[dispatch-reply] Reasoning", { text: payload.text });
                return;
              }

              // Received context compaction notice, skip message sending
              if (payload.isCompactionNotice) {
                ctx.log.info("[dispatch-reply] CompactionNotice", { text: payload.text });
                return;
              }

              // Normalize payload
              const normalized = normalizeOutboundReplyPayload(payload);
              ctx.log.info("[dispatch-reply] received reply data", {
                kind: info.kind,
                model_output: normalized.text,
              });

              // ⭐ Tool-kind deliver is tool execution result, not sent to user
              // Only update prevDeliverKind to track block→tool→block transitions
              if (info.kind === "tool") {
                prevDeliverKind = info.kind;
                return;
              }

              // Convert Markdown tables
              const text = core.channel.text.convertMarkdownTables(
                normalized.text ?? "",
                tableMode,
              );
              const mediaUrls = resolveOutboundMediaUrls(normalized);

              const trimmedText = text.trim();

              // Use real info.kind to track block→tool→block transitions
              const prevKind = prevDeliverKind;
              prevDeliverKind = info.kind;

              // Push text
              if (trimmedText) {
                const isAfterToolCall =
                  info.kind === "block" && prevKind !== null && prevKind !== "block";
                await queueSession.push({
                  type: "text",
                  text: isAfterToolCall ? `\n\n${text}` : text,
                });
                hasSentContent = true;
              }

              // Push media
              for (const mediaUrl of mediaUrls) {
                if (mediaUrl) {
                  await queueSession.push({ type: "media", mediaUrl });
                  hasSentContent = true;
                }
              }

              // Send heartbeat
              heartbeat.emit(WS_HEARTBEAT.RUNNING);
            },
            onError: (err: unknown, info: { kind: string }) => {
              if (ctx.abortSignal?.aborted) {
                ctx.log.warn(`[${account.accountId}] reply aborted, ignoring onDispatchError`);
                return;
              }
              ctx.log.error("[dispatch-reply] reply dispatch failed", {
                kind: info.kind,
                error: String(err),
              });
            },
          },
          replyOptions: {
            abortSignal: ctx.abortSignal,
            disableBlockStreaming: account.disableBlockStreaming,
            onModelSelected,
            onAgentRunStart: () => {
              heartbeat.emit(WS_HEARTBEAT.RUNNING);
            },
            onAssistantMessageStart: () => {
              heartbeat.emit(WS_HEARTBEAT.RUNNING);
            },
            // ⭐ Force-flush buffered text before tool_call starts,
            // so user doesn't have to wait until session.flush() to see pre-tool AI output
            onToolStart: async () => {
              try {
                await queueSession.drainNow();
              } catch (err) {
                ctx.log.error("[dispatch-reply] onToolStart drainNow failed, skipping", {
                  error: String(err),
                });
              }
            },
          },
        });

      // Use pipeline's unified traceContext (created by resolve-trace middleware)
      if (ctx.traceContext) {
        await runWithTraceContext(ctx.traceContext, doDispatchReply);
      } else {
        await doDispatchReply();
      }

      // ⭐ Append /status version info before flush
      if (ctx.rawBody.trim().startsWith("/status")) {
        await queueSession.push({
          type: "text",
          text: `\n\n🤖 Bot: yuanbaobot(${getPluginVersion()})`,
        });
      }

      // ⭐ Flush outbound queue
      const flushed = await queueSession.flush();
      if (!flushed && !hasSentContent && !ctx.abortSignal?.aborted) {
        const { fallbackReply } = account;
        if (fallbackReply) {
          ctx.log.warn("[dispatch-reply] AI returned no reply content, using fallback reply");
          // await sender.sendText(fallbackReply);
        } else {
          ctx.log.warn("[dispatch-reply] AI returned no reply content");
        }
      } else {
        ctx.statusSink?.({ lastOutboundAt: Date.now() });
        heartbeat.emit(WS_HEARTBEAT.FINISH);
      }
    } catch (err) {
      // Error path: abort queue, release resources
      queueSession.abort();
      heartbeat.stop();
      throw err;
    } finally {
      heartbeat.stop();
    }

    ctx.log.info("[dispatch-reply] message processing complete", {
      isGroup,
      groupCode,
      fromAccount,
    });

    await next();
  },
};
