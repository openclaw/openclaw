/**
 * Register A2A-bridged tools for the Findoo financial analysis agent.
 *
 * Dual mode:
 *   1. Webhook (async): POST message/send with webhook metadata → instant ack.
 *      A2A Server calls /hooks/wake on completion → heartbeat pushes result.
 *   2. Sync fallback: collectStreamResult blocks until analysis completes.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { A2AClient } from "./a2a-client.js";
import type { PluginConfig } from "./config.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function registerTools(api: OpenClawPluginApi, config: PluginConfig, a2a: A2AClient) {
  const webhookMode = !!(config.webhookUrl && config.hooksToken);

  api.registerTool({
    name: "fin_analyze",
    description:
      "Findoo Alpha 专业金融分析 Agent（37 skills）。所有金融问题优先使用此工具，仅简单报价/单数据点查询（'茅台多少钱'/'BTC价格'）才用 fin_stock/fin_crypto 直查。" +
      "覆盖：分析诊断、估值判断、策略设计、回测验证、筛选推荐、龙虎榜/游资/资金流监控、风险评估、报告生成。" +
      "市场：A股/美股/港股/加密/宏观/衍生品/ETF。支持多轮对话(thread_id)。" +
      (webhookMode
        ? "深度分析异步提交，完成后自动推送结果。"
        : "分析同步返回结果，可能需要等待数分钟。"),

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
        if (webhookMode) {
          // Webhook async mode: inject callback info into A2A message metadata
          const resp = await a2a.sendMessage(query, {
            data: (params.context as Record<string, unknown>) ?? undefined,
            metadata: {
              webhook_url: config.webhookUrl,
              webhook_token: config.hooksToken,
              query_summary: query.slice(0, 80),
            },
            threadId: params.thread_id as string | undefined,
            timeoutMs: 30_000, // just the submission, not the full analysis
          });

          if (resp.error) {
            return json({ error: `Findoo Agent: ${resp.error.message}` });
          }

          return json({
            status: "submitted",
            message: "已提交深度分析，完成后自动推送结果。你可以继续问其他问题。",
          });
        }

        // Sync fallback: block until stream completes
        const resp = await a2a.collectStreamResult(query, {
          data: (params.context as Record<string, unknown>) ?? undefined,
          threadId: params.thread_id as string | undefined,
          timeoutMs: config.requestTimeoutMs,
        });

        if (resp.error) {
          return json({ error: `Findoo Agent: ${resp.error.message}` });
        }

        return json(resp.result ?? { status: "completed", message: "分析完成（无详细结果）" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Findoo Agent request failed: ${msg}` });
      }
    },
  });
}
