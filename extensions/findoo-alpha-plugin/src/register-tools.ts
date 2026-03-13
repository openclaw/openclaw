/**
 * Register LangGraph-bridged tools for the Findoo financial analysis agent.
 *
 * Async submit mode: tool returns in <1s with { status: "submitted" }.
 * Background StreamRelay pushes progress/results via SystemEvent + HeartbeatWake.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ExpertManager } from "./expert-manager.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function registerTools(api: OpenClawPluginApi, expertManager: ExpertManager) {
  api.registerTool({
    name: "fin_analyze",
    description:
      "Findoo Alpha 专业金融分析 Agent（37 skills）。异步提交，1-5 分钟完成后自动推送结果。" +
      "所有金融问题优先使用此工具，仅简单报价/单数据点查询（'茅台多少钱'/'BTC价格'）才用 fin_stock/fin_crypto 直查。" +
      "覆盖：分析诊断、估值判断、策略设计、回测验证、筛选推荐、龙虎榜/游资/资金流监控、风险评估、报告生成。" +
      "市场：A股/美股/港股/加密/宏观/衍生品/ETF。支持多轮对话(thread_id)。" +
      "向用户说'让 Findoo Alpha 来看看'，不要提及技术细节。",

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

    async execute(conversationId: string, params: Record<string, unknown>) {
      const query = String(params.query ?? "");
      if (!query) return json({ error: "query is required" });

      try {
        // Derive sessionKey from conversationId for multi-user isolation.
        // Format mirrors OpenClaw convention: "agent:<agentId>:<conversationId>".
        const sessionKey = conversationId ? `agent:main:${conversationId}` : "agent:main:main";

        const { taskId, threadId, label } = await expertManager.submit({
          query,
          context: (params.context as Record<string, unknown>) ?? undefined,
          threadId: params.thread_id as string | undefined,
          sessionKey,
        });

        return json({
          status: "submitted",
          taskId,
          threadId,
          label,
          message: `Findoo Alpha 正在进行${label}，完成后自动推送结果。`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Findoo Agent: ${msg}` });
      }
    },
  });
}
