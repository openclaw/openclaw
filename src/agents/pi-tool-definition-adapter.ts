import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { logDebug, logError } from "../logger.js";
import { jsonResult } from "./tools/common.js";

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
type AnyAgentTool = AgentTool<any, unknown>;

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function asScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return undefined;
}

function summarizeList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(asScalar).filter((entry): entry is string => Boolean(entry));
  if (items.length === 0) return undefined;
  const sample = items.slice(0, 3).join(", ");
  const suffix = items.length > 3 ? ` (+${items.length - 3})` : "";
  return `${sample}${suffix}`;
}

function looksLikeMemberTarget(value: string): boolean {
  return /^user:/i.test(value) || value.startsWith("@") || /^<@!?/.test(value);
}

function describeMessageToolContext(params: Record<string, unknown>): string | undefined {
  const action = asScalar(params.action);
  const channel = asScalar(params.channel);
  const accountId = asScalar(params.accountId);
  const guildId = asScalar(params.guildId);
  const channelId = asScalar(params.channelId);
  const threadId = asScalar(params.threadId);
  const messageId = asScalar(params.messageId);
  const userId = asScalar(params.userId) ?? asScalar(params.authorId) ?? asScalar(params.participant);
  const target =
    asScalar(params.target) ??
    asScalar(params.to) ??
    summarizeList(params.targets) ??
    summarizeList(params.target);

  const member =
    userId ?? (target && looksLikeMemberTarget(target) ? target : undefined) ?? undefined;
  const pairs: string[] = [];
  if (action) pairs.push(`action=${action}`);
  if (channel) pairs.push(`channel=${channel}`);
  if (accountId) pairs.push(`accountId=${accountId}`);
  if (member) {
    pairs.push(`member=${member}`);
  } else if (target) {
    pairs.push(`target=${target}`);
  }
  if (guildId) pairs.push(`guildId=${guildId}`);
  if (channelId) pairs.push(`channelId=${channelId}`);
  if (threadId) pairs.push(`threadId=${threadId}`);
  if (messageId) pairs.push(`messageId=${messageId}`);
  return pairs.length > 0 ? pairs.join(" ") : undefined;
}

function describeToolContext(toolName: string, params: Record<string, unknown>): string | undefined {
  if (toolName === "message") return describeMessageToolContext(params);
  return undefined;
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema from pi-agent-core uses a different module instance.
      parameters: tool.parameters as any,
      execute: async (
        toolCallId,
        params,
        onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx,
        signal,
      ): Promise<AgentToolResult<unknown>> => {
        // KNOWN: pi-coding-agent `ToolDefinition.execute` has a different signature/order
        // than pi-agent-core `AgentTool.execute`. This adapter keeps our existing tools intact.
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          if (signal?.aborted) throw err;
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") throw err;
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${tool.name} failed stack:\n${described.stack}`);
          }
          const context = describeToolContext(tool.name, params);
          const suffix = context ? ` (${context})` : "";
          logError(`tools: ${tool.name} failed: ${described.message}${suffix}`);
          return jsonResult({
            status: "error",
            tool: tool.name,
            error: described.message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}
