import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { callSense, checkSenseHealth } from "./client.js";

type SensePluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  token?: string;
  tokenEnv?: string;
};

function normalizeTimeout(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function summarizeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.result === "string" && record.result.trim()) {
      return record.result.trim();
    }
    if (typeof record.status === "string" && record.status.trim()) {
      return `Sense worker status: ${record.status.trim()}`;
    }
  }
  return JSON.stringify(body, null, 2);
}

export function createSenseWorkerTool(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as SensePluginConfig;
  const baseUrl = pluginConfig.baseUrl?.trim() || undefined;
  const timeoutMs = normalizeTimeout(pluginConfig.timeoutMs, 5_000);
  const token = pluginConfig.token?.trim() || undefined;
  const tokenEnv = pluginConfig.tokenEnv?.trim() || undefined;

  return {
    name: "sense-worker",
    label: "Sense Worker",
    description:
      "Call the Sense worker node over LAN for offloaded summarize, generate_draft, or heavy compute tasks.",
    parameters: Type.Object({
      action: Type.Unsafe<"health" | "execute">({ type: "string", enum: ["health", "execute"] }),
      task: Type.Optional(
        Type.String({
          description: "Remote task name for execute, e.g. summarize or generate_draft.",
        }),
      ),
      input: Type.Optional(Type.String({ description: "Task input text for the Sense worker." })),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON object forwarded to the Sense worker as params.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Per-request timeout override in milliseconds." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "";
      const requestTimeoutMs = normalizeTimeout(params.timeoutMs, timeoutMs);
      if (action === "health") {
        const result = await checkSenseHealth({
          baseUrl,
          timeoutMs: requestTimeoutMs,
          token,
          tokenEnv,
          logger: api.logger,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
          details: result,
        };
      }
      if (action !== "execute") {
        throw new Error("action must be health or execute");
      }
      const task = typeof params.task === "string" ? params.task : "";
      const input = typeof params.input === "string" ? params.input : "";
      const forwardParams =
        params.params && typeof params.params === "object" && !Array.isArray(params.params)
          ? (params.params as Record<string, unknown>)
          : {};
      const result = await callSense(task, input, forwardParams, {
        baseUrl,
        timeoutMs: requestTimeoutMs,
        token,
        tokenEnv,
        logger: api.logger,
      });
      return {
        content: [{ type: "text", text: summarizeBody(result.body) }],
        details: result,
      };
    },
  };
}
