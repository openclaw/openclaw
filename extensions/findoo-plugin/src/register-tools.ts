/**
 * Register A2A-bridged tools for the Findoo financial analysis agent.
 *
 * Each tool delegates to the remote agent via A2A JSON-RPC 2.0:
 *   POST /a2a/{assistant_id}  → method: "message/stream" (SSE)
 *
 * The agent has 37 skills covering A股/美股/港股/加密/宏观/风控 full spectrum.
 * We expose a single tool (fin_analyze) that submits the query via SSE stream,
 * grabs the taskId from the first event (~1-2s), and hands the remaining
 * stream to PendingTaskTracker for background consumption + heartbeat push.
 *
 * Why stream-based instead of poll-based?
 * The LangGraph A2A server cleans up tasks after the stream ends.
 * tasks/get only works while the stream is active, so the stream itself
 * is the only reliable channel to receive the final result.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { A2AClient, A2AStreamEvent } from "./a2a-client.js";
import type { PluginConfig } from "./config.js";
import type { PendingTaskTracker } from "./pending-task-tracker.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function registerTools(
  api: OpenClawPluginApi,
  config: PluginConfig,
  a2a: A2AClient,
  tracker?: PendingTaskTracker,
) {
  // ----------------------------------------------------------------
  // fin_analyze — Primary analysis tool (A2A bridge to Findoo Agent)
  // ----------------------------------------------------------------
  api.registerTool({
    name: "fin_analyze",
    description:
      "Findoo 专业金融分析 Agent（37 skills）。所有金融问题优先使用此工具，仅简单报价/单数据点查询（'茅台多少钱'/'BTC价格'）才用 fin_stock/fin_crypto 直查。" +
      "覆盖：分析诊断、估值判断、策略设计、回测验证、筛选推荐、龙虎榜/游资/资金流监控、风险评估、报告生成。" +
      "市场：A股/美股/港股/加密/宏观/衍生品/ETF。支持多轮对话(thread_id)。" +
      "深度分析任务异步提交，完成后自动推送结果到对话。",

    parameters: Type.Object({
      query: Type.String({
        description: "分析需求（自然语言），Agent 自动选择最佳 skill(s)",
      }),
      context: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: "附加结构化上下文（symbols, risk_profile, portfolio 等）",
          },
        ),
      ),
      thread_id: Type.Optional(
        Type.String({ description: "复用之前的对话上下文 threadId，用于多轮分析" }),
      ),
    }),

    async execute(_conversationId: string, params: Record<string, unknown>) {
      const query = String(params.query ?? "");
      if (!query) return json({ error: "query is required" });

      try {
        // Open SSE stream — first event arrives in ~1-2s with taskId.
        // Use taskTimeoutMs (not requestTimeoutMs) since the stream may run
        // for minutes in background while the tracker consumes it.
        const stream = a2a.sendMessageStream(query, {
          data: (params.context as Record<string, unknown>) ?? undefined,
          threadId: params.thread_id as string | undefined,
          timeoutMs: config.taskTimeoutMs,
        });

        // Read first event to get taskId
        const first = await stream.next();
        if (first.done) return json({ error: "No response from Findoo Agent" });

        const firstEvent: A2AStreamEvent = first.value;

        if (firstEvent.kind === "error") {
          const errMsg =
            (firstEvent.raw as Record<string, unknown>)?.error ??
            firstEvent.status?.message ??
            "Unknown stream error";
          return json({
            error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
          });
        }

        // If final already (instant response for simple queries), return directly
        if (firstEvent.final) {
          const result = firstEvent.status?.message ?? firstEvent.raw;
          return json(result as Record<string, unknown>);
        }

        const taskId = extractTaskId(firstEvent.raw);
        const contextId = (firstEvent.raw as Record<string, unknown>).contextId as
          | string
          | undefined;

        // Hand the remaining stream to tracker for background consumption
        if (taskId && tracker) {
          tracker.trackStream(taskId, query, stream, {
            threadId: params.thread_id as string | undefined,
            contextId,
          });
          return json({
            status: "submitted",
            taskId,
            message: `已提交深度分析任务 (${taskId.slice(0, 8)}…)，预计 1-5 分钟完成。你可以继续问其他问题，分析完成后会自动推送结果。`,
          });
        }

        // No tracker — consume stream synchronously (fallback to blocking mode)
        let lastEvent = firstEvent;
        for await (const event of stream) {
          lastEvent = event;
          if (event.final) break;
        }
        const result = lastEvent.status?.message ?? lastEvent.raw;
        return json(result as Record<string, unknown>);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Findoo Agent request failed: ${msg}` });
      }
    },
  });
}

/** Extract taskId from various A2A event/response shapes */
function extractTaskId(raw: Record<string, unknown>): string | undefined {
  // Direct id field (common in stream task events)
  if (typeof raw.id === "string" && raw.id.length > 8) return raw.id;
  // Nested: raw.taskId or raw.task_id
  if (typeof raw.taskId === "string") return raw.taskId;
  if (typeof raw.task_id === "string") return raw.task_id;
  // Nested: raw.task.id
  const task = raw.task as Record<string, unknown> | undefined;
  if (typeof task?.id === "string") return task.id;
  return undefined;
}
