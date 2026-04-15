/**
 * 中间件：AI 回复调度
 *
 * 手动分步调用 recordInboundSession + dispatchReplyWithBufferedBlockDispatcher，
 * 使 deliver 回调能拿到 info.kind（block/tool/final）参数，
 * 正确区分回复块类型，避免 tool-call 结果被当作普通文本发送。
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

    // yuanbao 客户端原生渲染 Markdown 表格，固定使用 'off'
    const tableMode = "off" as const;

    ctx.log.debug("[dispatch-reply] generating reply", {
      target: isGroup ? `group:${groupCode}` : fromAccount,
    });

    // ⭐ 创建心跳控制器（使用真实Logger instance替代空函数）
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

    // 追踪 deliver kind 转换，检测 tool-call 边界
    let prevDeliverKind: string | null = null;
    let hasSentContent = false;

    try {
      // ⭐ 第一步：记录入站会话
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          ctx.log.error("[dispatch-reply] recordInboundSession failed", { error: String(err) });
        },
      });

      // ⭐ 第二步：创建回复管线
      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: config,
        agentId: route.agentId,
        channel: "yuanbao",
        accountId: account.accountId,
      });

      // ⭐ 第三步：调度回复（deliver 回调带 info.kind）
      // 使用 runWithTraceContext 包裹，确保 AI 请求的 fetch interceptor 能自动注入 X-Traceparent 头
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

              // 收到上下文压缩通知，不进行消息发送
              if (payload.isCompactionNotice) {
                ctx.log.info("[dispatch-reply] CompactionNotice", { text: payload.text });
                return;
              }

              // 规范化 payload
              const normalized = normalizeOutboundReplyPayload(payload);
              ctx.log.info("[dispatch-reply] received reply data", {
                kind: info.kind,
                model_output: normalized.text,
              });

              // ⭐ tool 类型的 deliver 是 tool 执行结果，不发送给用户
              // 仅更新 prevDeliverKind 以追踪 block→tool→block 转换
              if (info.kind === "tool") {
                prevDeliverKind = info.kind;
                return;
              }

              // 转换 Markdown 表格
              const text = core.channel.text.convertMarkdownTables(
                normalized.text ?? "",
                tableMode,
              );
              const mediaUrls = resolveOutboundMediaUrls(normalized);

              const trimmedText = text.trim();

              // 利用真实的 info.kind 追踪 block→tool→block 转换
              const prevKind = prevDeliverKind;
              prevDeliverKind = info.kind;

              // 推入文本
              if (trimmedText) {
                const isAfterToolCall =
                  info.kind === "block" && prevKind !== null && prevKind !== "block";
                await queueSession.push({
                  type: "text",
                  text: isAfterToolCall ? `\n\n${text}` : text,
                });
                hasSentContent = true;
              }

              // 推入Media
              for (const mediaUrl of mediaUrls) {
                if (mediaUrl) {
                  await queueSession.push({ type: "media", mediaUrl });
                  hasSentContent = true;
                }
              }

              // 发送心跳
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
            // ⭐ tool_call 开始前强制把缓冲区里已积累的文本立即发出，
            // 避免用户等到 session.flush() 才能看到工具调用前的 AI 输出
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

      // 使用管线统一的 traceContext（由 resolve-trace 中间件创建）
      if (ctx.traceContext) {
        await runWithTraceContext(ctx.traceContext, doDispatchReply);
      } else {
        await doDispatchReply();
      }

      // ⭐ flush 前追加 /status 版本信息
      if (ctx.rawBody.trim().startsWith("/status")) {
        await queueSession.push({
          type: "text",
          text: `\n\n🤖 Bot: yuanbaobot(${getPluginVersion()})`,
        });
      }

      // ⭐ flush 出站队列
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
      // 异常路径：中止队列，释放资源
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
