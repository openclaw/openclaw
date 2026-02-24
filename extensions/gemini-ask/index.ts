import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { askGemini, type GeminiModel } from "./src/ask-gemini.js";

type PluginCfg = {
  profile?: string;
  defaultModel?: string;
  timeoutMs?: number;
};

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;

  const tool = {
    name: "ask_gemini",
    label: "Ask Gemini",
    description: [
      "Ask Google Gemini AI a question and return its answer.",
      "This tool opens gemini.google.com in the managed browser,",
      "selects the requested model, types the question, waits for the response,",
      "and returns the answer text.",
      "Use this when the user wants to query Gemini directly.",
      'Supported models: "flash" (fast), "pro" (advanced), "thinking" (deep reasoning).',
    ].join(" "),
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask Gemini." }),
      model: Type.Optional(
        Type.String({
          description:
            'Gemini model variant: "flash" (default, fast), "pro" (advanced), "thinking" (deep reasoning).',
        }),
      ),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: "question is required" }),
            },
          ],
        };
      }

      const rawModel = typeof args.model === "string" ? args.model.trim().toLowerCase() : "";
      const modelMap: Record<string, GeminiModel> = {
        flash: "flash",
        pro: "pro",
        thinking: "thinking",
        "2.0 flash": "flash",
        "1.5 pro": "pro",
        "gemini flash": "flash",
        "gemini pro": "pro",
      };
      const model: GeminiModel = modelMap[rawModel] ?? (cfg.defaultModel as GeminiModel) ?? "flash";

      const result = await askGemini({
        question,
        model,
        profile: cfg.profile ?? "openclaw",
        timeoutMs: cfg.timeoutMs ?? 60_000,
      });

      if (result.ok && result.answer) {
        return {
          content: [
            {
              type: "text" as const,
              text: `根据 Gemini (${result.model ?? model}) 的回答：\n\n${result.answer}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, error: result.error ?? "No answer received" }),
          },
        ],
      };
    },
  };

  api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
}
