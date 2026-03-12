/**
 * Register A2A-bridged tools for the Findoo financial analysis agent.
 *
 * Each tool delegates to the remote agent via A2A JSON-RPC 2.0:
 *   POST /a2a/{assistant_id}  → method: "message/send" | "tasks/get"
 *
 * The agent has 37 skills covering A股/美股/港股/加密/宏观/风控 full spectrum.
 * We expose a single high-level tool (fin_analyze) that routes the user's
 * natural-language query to the agent, letting its internal skill router
 * select the best skill(s).
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { A2AClient } from "./a2a-client.js";
import type { PluginConfig } from "./config.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function registerTools(api: OpenClawPluginApi, config: PluginConfig) {
  const a2a = new A2AClient(config.strategyAgentUrl, config.strategyAssistantId);

  // ----------------------------------------------------------------
  // fin_analyze — Primary analysis tool (A2A bridge to Findoo Agent)
  // ----------------------------------------------------------------
  api.registerTool({
    name: "fin_analyze",
    description:
      "Findoo 专业金融分析 Agent（37 skills）。所有金融问题优先使用此工具，仅简单报价/单数据点查询（'茅台多少钱'/'BTC价格'）才用 fin_stock/fin_crypto 直查。" +
      "覆盖：分析诊断、估值判断、策略设计、回测验证、筛选推荐、龙虎榜/游资/资金流监控、风险评估、报告生成。" +
      "市场：A股/美股/港股/加密/宏观/衍生品/ETF。支持多轮对话(thread_id)。",

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
        const resp = await a2a.sendMessage(query, {
          data: (params.context as Record<string, unknown>) ?? undefined,
          threadId: params.thread_id as string | undefined,
          timeoutMs: config.requestTimeoutMs,
        });

        if (resp.error) {
          return json({ error: resp.error.message, code: resp.error.code });
        }

        return json(resp.result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Findoo Agent request failed: ${msg}` });
      }
    },
  });

  // ----------------------------------------------------------------
  // fin_analyze_task — Query async task status/result
  // ----------------------------------------------------------------
  api.registerTool({
    name: "fin_analyze_task",
    description:
      "查询 Findoo Agent 异步任务的状态和结果。当 fin_analyze 返回的任务尚未完成时使用。",

    parameters: Type.Object({
      task_id: Type.String({ description: "任务 ID（从 fin_analyze 返回）" }),
    }),

    async execute(_conversationId: string, params: Record<string, unknown>) {
      const taskId = String(params.task_id ?? "");
      if (!taskId) return json({ error: "task_id is required" });

      try {
        const resp = await a2a.getTask(taskId);
        if (resp.error) {
          return json({ error: resp.error.message, code: resp.error.code });
        }
        return json(resp.result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Task query failed: ${msg}` });
      }
    },
  });

  // ----------------------------------------------------------------
  // fin_analyze_skills — List available agent skills
  // ----------------------------------------------------------------
  api.registerTool({
    name: "fin_analyze_skills",
    description: "列出 Findoo Agent 所有可用的分析 skill 和能力范围。",

    parameters: Type.Object({}),

    async execute() {
      try {
        const resp = await fetch(`${config.strategyAgentUrl}/assistants/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        });
        const assistants = await resp.json();
        return json({
          agent_url: config.strategyAgentUrl,
          assistant_id: config.strategyAssistantId,
          assistants: Array.isArray(assistants)
            ? assistants.map((a: Record<string, unknown>) => ({
                id: a.assistant_id,
                graph: a.graph_id,
                name: a.name,
              }))
            : [],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Failed to list skills: ${msg}` });
      }
    },
  });
}
