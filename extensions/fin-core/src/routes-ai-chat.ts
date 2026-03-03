/**
 * AI chat HTTP route handler for dashboard AI assistant panels.
 * Unified endpoint for all 3 dashboard pages (overview, trading-desk, strategy-lab).
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { HttpReq, HttpRes, RuntimeServices } from "./types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "./types-http.js";

export function registerAiChatRoute(
  api: OpenClawPluginApi,
  runtime: RuntimeServices,
): void {
  // POST /api/v1/finance/ai/chat -- Unified AI chat for dashboard panels
  api.registerHttpRoute({
    path: "/api/v1/finance/ai/chat",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { message, question, context, page } = body as {
          message?: string;
          question?: string;
          context?: Record<string, unknown>;
          page?: string;
        };
        const text = (message || question) as string;

        if (!text?.trim()) {
          errorResponse(res, 400, "Missing message");
          return;
        }

        // Try to route through the agent service if available
        const agent = runtime.services?.get?.("agent") as
          | { sendMessage?: (...args: unknown[]) => Promise<string> }
          | undefined;

        if (agent?.sendMessage) {
          const contextStr = context
            ? `\n[Dashboard: ${page ?? "unknown"}, Context: ${JSON.stringify(context)}]`
            : "";
          const reply = await agent.sendMessage(text + contextStr);
          jsonResponse(res, 200, { reply, role: "assistant" });
        } else {
          // Graceful fallback when agent is not configured
          jsonResponse(res, 200, {
            reply: `收到你的问题："${text.slice(0, 100)}"。AI 聊天功能需要配置 agent 服务。请通过主界面 Chat 标签与 FinClaw 对话。`,
            role: "assistant",
            fallback: true,
          });
        }
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });
}
