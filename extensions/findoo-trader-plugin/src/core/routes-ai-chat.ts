/**
 * AI chat HTTP route handler for dashboard AI assistant panels.
 * Unified endpoint for all 3 dashboard pages (overview, trading-desk, strategy-lab).
 *
 * Priority chain:
 *   1. Agent service (runtime.services.get("agent"))  — full agentic loop
 *   2. Gateway LLM   (http://127.0.0.1:<port>/v1/chat/completions) — direct LLM call
 *   3. Static fallback — tells user to configure LLM
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { HttpReq, HttpRes, RuntimeServices } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";

function buildSystemPrompt(page?: string, context?: Record<string, unknown>): string {
  const parts = [
    "You are FinClaw AI, the embedded financial assistant for the OpenFinClaw trading dashboard.",
    "Answer concisely in the same language the user writes in.",
    "You have access to the user's portfolio context below.",
  ];
  if (page) parts.push(`The user is currently on the "${page}" page.`);
  if (context) {
    const ctx = Object.entries(context)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    if (ctx) parts.push(`Dashboard context: ${ctx}`);
  }
  return parts.join(" ");
}

export function registerAiChatRoute(api: OpenClawPluginApi, runtime: RuntimeServices): void {
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

        // 1. Try agent service (full agentic loop)
        const agent = runtime.services?.get?.("agent") as
          | { sendMessage?: (...args: unknown[]) => Promise<string> }
          | undefined;

        if (agent?.sendMessage) {
          const contextStr = context
            ? `\n[Dashboard: ${page ?? "unknown"}, Context: ${JSON.stringify(context)}]`
            : "";
          const reply = await agent.sendMessage(text + contextStr);
          jsonResponse(res, 200, { reply, role: "assistant" });
          return;
        }

        // 2. Fallback: call gateway's /v1/chat/completions directly
        const gatewayPort =
          (api.config as Record<string, unknown>)?.gateway &&
          typeof ((api.config as Record<string, unknown>).gateway as Record<string, unknown>)
            ?.port === "number"
            ? ((api.config as Record<string, unknown>).gateway as Record<string, unknown>).port
            : 18789;

        try {
          const gatewayRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "default",
              messages: [
                { role: "system", content: buildSystemPrompt(page, context) },
                { role: "user", content: text },
              ],
            }),
          });

          if (!gatewayRes.ok) {
            throw new Error(`Gateway returned ${gatewayRes.status}`);
          }

          const data = (await gatewayRes.json()) as {
            choices?: { message?: { content?: string } }[];
          };
          const reply = data.choices?.[0]?.message?.content ?? "No response from LLM.";
          jsonResponse(res, 200, { reply, role: "assistant" });
        } catch (llmErr) {
          // 3. Final fallback: static message
          jsonResponse(res, 200, {
            reply: `收到你的问题："${text.slice(0, 100)}"。当前无法连接 LLM 服务 (${(llmErr as Error).message})。请确保 gateway 已启动，或通过主界面 Chat 标签与 FinClaw 对话。`,
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
