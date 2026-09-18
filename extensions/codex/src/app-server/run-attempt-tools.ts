import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import {
  readSynchronousCoreFileReceipt,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import {
  collectDynamicToolContentText,
  truncateToolTranscriptText,
} from "./event-projector-tool-output.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";
import { sanitizeCodexToolResponse } from "./tool-progress-normalization.js";

export function toTranscriptToolResult(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  const sanitized = sanitizeCodexToolResponse(response);
  const contentItems = Array.isArray(sanitized.contentItems) ? sanitized.contentItems : [];
  const result: Record<string, unknown> = {
    ...sanitized,
    // Progress events are UI/transcript-facing; map only sanitized content so
    // event redaction cannot be bypassed by raw dynamic tool output.
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
  delete result.contentItems;
  delete result.success;
  return result;
}

function toTranscriptToolResultContentItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return { type: "text", text: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type === "inputText") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "inputImage") {
    return typeof record.imageUrl === "string"
      ? { type: "image", url: record.imageUrl }
      : { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
  }
  return { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
}

function formatUnsupportedCodexDynamicToolOutput(type: unknown): string {
  const rawType = typeof type === "string" ? type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? truncateUtf16Safe(rawType, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return `[Unsupported Codex dynamic tool output: ${label}${suffix}]`;
}

type CodexDynamicToolExecutionIdentity = Pick<
  CodexDynamicToolCallParams,
  "threadId" | "turnId" | "callId"
>;

export function createCodexDynamicToolExecutionRegistry() {
  const executions = new Map<string, Promise<CodexDynamicToolRuntimeResponse>>();
  const settled = new Map<string, { tool: string; arguments: unknown; text: string }>();
  const keyFor = (call: CodexDynamicToolExecutionIdentity) =>
    JSON.stringify([call.threadId, call.turnId, call.callId]);

  return {
    get size() {
      return executions.size;
    },
    isSettled(call: CodexDynamicToolExecutionIdentity) {
      return settled.has(keyFor(call));
    },
    matchesSettledTranscript(threadId: string, turnId: string, messages: readonly unknown[]) {
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const value of messages) {
        const message = asRecord(value);
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          for (const part of message.content) {
            const block = asRecord(part);
            if (block?.type !== "toolCall") {
              continue;
            }
            if (typeof block.id !== "string" || calls.has(block.id)) {
              return false;
            }
            const receipt = settled.get(keyFor({ threadId, turnId, callId: block.id }));
            if (
              !receipt ||
              block.name !== receipt.tool ||
              !isDeepStrictEqual(block.arguments, receipt.arguments) ||
              (block.input !== undefined && !isDeepStrictEqual(block.input, receipt.arguments))
            ) {
              return false;
            }
            calls.add(block.id);
          }
        } else if (message?.role === "toolResult") {
          if (
            typeof message.toolCallId !== "string" ||
            !calls.has(message.toolCallId) ||
            results.has(message.toolCallId)
          ) {
            return false;
          }
          const receipt = settled.get(keyFor({ threadId, turnId, callId: message.toolCallId }));
          const content =
            Array.isArray(message.content) && message.content.length === 1
              ? asRecord(message.content[0])
              : undefined;
          if (
            !receipt ||
            message.toolName !== receipt.tool ||
            message.isError !== false ||
            !content ||
            !["text", "toolResult"].includes(String(content.type)) ||
            content.text !== receipt.text ||
            (content.type === "toolResult" && content.content !== receipt.text)
          ) {
            return false;
          }
          results.add(message.toolCallId);
        }
      }
      return (
        executions.size > 0 &&
        calls.size === executions.size &&
        results.size === executions.size &&
        settled.size === executions.size
      );
    },
    get(call: CodexDynamicToolExecutionIdentity) {
      return executions.get(keyFor(call));
    },
    claim(
      call: CodexDynamicToolExecutionIdentity &
        Partial<Pick<CodexDynamicToolCallParams, "tool" | "arguments">>,
      start: () => Promise<CodexDynamicToolRuntimeResponse>,
    ) {
      const existing = executions.get(keyFor(call));
      if (existing) {
        return { execution: existing, replayed: true } as const;
      }
      const executionKey = keyFor(call);
      let incoming: { tool: string | undefined; arguments: unknown } | undefined;
      try {
        incoming = { tool: call.tool, arguments: structuredClone(call.arguments) };
      } catch {
        // Execution can proceed normally, but uncloneable evidence cannot grant custody.
      }
      const execution = start().then((response) => {
        const receipt = response.terminalResolution?.effectReceipt;
        const concrete = readSynchronousCoreFileReceipt(response);
        if (
          response.success &&
          concrete &&
          !response.asyncStarted &&
          response.terminalResolution?.executionStarted === true &&
          (receipt?.state === "read_completed" || receipt?.state === "mutation_committed")
        ) {
          try {
            const portable = sanitizeCodexToolResponse(response);
            const untrimmed = collectDynamicToolContentText(response.contentItems);
            const text = untrimmed.trim();
            if (
              incoming?.tool === concrete.tool &&
              isDeepStrictEqual(JSON.parse(concrete.argumentsJson), response.executedArguments) &&
              isDeepStrictEqual(JSON.parse(concrete.contentJson), response.contentItems) &&
              incoming?.tool &&
              incoming.arguments !== undefined &&
              isDeepStrictEqual(incoming.arguments, response.executedArguments) &&
              response.contentItems.every(
                (item) => item.type === "inputText" && typeof item.text === "string",
              ) &&
              isDeepStrictEqual(portable.contentItems, response.contentItems) &&
              text.length > 0 &&
              text === untrimmed &&
              truncateToolTranscriptText(text) === text
            ) {
              settled.set(executionKey, {
                tool: incoming.tool,
                arguments: structuredClone(response.executedArguments),
                text,
              });
            }
          } catch {
            // Optional continuation never replaces a completed operation with a thrown retry.
          }
        }
        return response;
      });
      executions.set(executionKey, execution);
      return { execution, replayed: false } as const;
    },
  };
}

export function resolveCodexDynamicToolDirectNames(
  params: EmbeddedRunAttemptParams,
  registeredTools: readonly { name: string }[],
  hostSystemAgentActive = false,
): string[] {
  // Tools with catalogMode=direct-only use the model-only namespace. This list
  // remains for control tools that intentionally live at the dynamic-tool root.
  const names: string[] = [];
  // OpenClaw is the run's only tool and must stay callable when Codex tool
  // search is unavailable. Exact toolsAllow is the public harness contract.
  if (hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)) {
    names.push("openclaw");
  }
  // Registration owns persistent layout; a turn may narrow execution without
  // moving this tool into a namespace and changing the thread fingerprint.
  if (registeredTools.some((tool) => tool.name === "message")) {
    names.push("message");
  }
  return names;
}
