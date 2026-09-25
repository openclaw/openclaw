import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AssistantMessage, ToolResultMessage, Usage } from "../../llm/types.js";
import { makeZeroUsageSnapshot, type NormalizedUsage } from "../usage.js";

export type AgentHarnessMessageAttribution = {
  api: AssistantMessage["api"];
  provider: string;
  modelId: string;
};

export type AgentHarnessAssistantMessageOptions = {
  tokenUsage?: NormalizedUsage;
  aborted: boolean;
  promptError?: unknown;
  errorMessage?: string;
  diagnostics?: AssistantMessage["diagnostics"];
  timestamp?: number;
  content?: AssistantMessage["content"];
};

export function createAgentHarnessAssistantMessage(
  attribution: AgentHarnessMessageAttribution,
  text: string,
  options: AgentHarnessAssistantMessageOptions,
): AssistantMessage {
  const message = {
    role: "assistant",
    content: options.content ?? [{ type: "text", text }],
    api: attribution.api,
    provider: attribution.provider,
    model: attribution.modelId,
    usage: createAgentHarnessMessageUsage(options.tokenUsage),
    stopReason: options.aborted
      ? "aborted"
      : options.promptError || options.errorMessage
        ? "error"
        : "stop",
    errorMessage:
      options.errorMessage ??
      (options.promptError ? formatErrorMessage(options.promptError) : undefined),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    timestamp: options.timestamp ?? Date.now(),
  } satisfies AssistantMessage;
  return message;
}

export function createAgentHarnessToolCallMessage(
  attribution: AgentHarnessMessageAttribution,
  input: { id: string; name: string; arguments?: unknown },
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: input.id,
        name: input.name,
        arguments: asNonArrayRecord(input.arguments),
      },
    ],
    api: attribution.api,
    provider: attribution.provider,
    model: attribution.modelId,
    usage: makeZeroUsageSnapshot(),
    stopReason: "toolUse",
    timestamp,
  };
}

export function createAgentHarnessToolResultMessage(
  input: {
    id: string;
    name: string;
    text?: string;
    content?: ToolResultMessage["content"];
    isError: boolean;
    details?: unknown;
  },
  timestamp: number,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: input.id,
    toolName: input.name,
    isError: input.isError,
    content: input.content ?? [
      {
        type: "text",
        text: input.text ?? `${input.name} ${input.isError ? "failed" : "completed"}`,
      },
    ],
    ...(input.details !== undefined ? { details: input.details } : {}),
    timestamp,
  };
}

function createAgentHarnessMessageUsage(usage: NormalizedUsage | undefined): Usage {
  const zero = makeZeroUsageSnapshot();
  return usage
    ? {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.contextUsage ? { contextUsage: usage.contextUsage } : {}),
        totalTokens:
          usage.total ??
          (usage.input ?? 0) +
            (usage.output ?? 0) +
            (usage.cacheRead ?? 0) +
            (usage.cacheWrite ?? 0),
        cost: zero.cost,
      }
    : zero;
}
