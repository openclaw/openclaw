import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function stringifyHistoricalValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[Unserializable historical value]";
  }
}

export function createVeniceStreamWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, context, model }) => {
    if (
      model.provider === "venice" &&
      (model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
    ) {
      delete payload.thinking;
      delete payload.reasoning;
      delete payload.reasoning_effort;
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: true,
        replaceNullReasoningContent: true,
      });
    }
    if (model.provider !== "venice" || !model.id.trim().toLowerCase().startsWith("gemini-")) {
      return;
    }
    const historicalToolCallBatches: Array<
      Array<{ id: string; name: string; thoughtSignature?: string }>
    > = [];
    let hasHistoricalSignature = false;
    const requiresUnsignedCallFallback = /^gemini-3(?:[.-]|$)/.test(model.id.trim().toLowerCase());
    for (const message of context.messages) {
      if (
        message.role !== "assistant" ||
        message.stopReason === "error" ||
        message.stopReason === "aborted"
      ) {
        continue;
      }
      const isExactRoute =
        message.api === model.api &&
        message.provider === model.provider &&
        message.model === model.id;
      const batch: Array<{ id: string; name: string; thoughtSignature?: string }> = [];
      for (const block of message.content) {
        if (block.type !== "toolCall") {
          continue;
        }
        const thoughtSignature = isExactRoute ? block.thoughtSignature || undefined : undefined;
        hasHistoricalSignature ||= thoughtSignature !== undefined;
        batch.push({
          id: block.id,
          name: block.name,
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      if (batch.length > 0) {
        historicalToolCallBatches.push(batch);
      }
    }
    if (
      (!hasHistoricalSignature && !requiresUnsignedCallFallback) ||
      !Array.isArray(payload.messages)
    ) {
      return;
    }
    let historicalBatchIndex = 0;
    let pendingDowngradedToolCalls: Map<string, string[]> | undefined;
    for (const message of payload.messages) {
      const record = asOptionalObjectRecord(message);
      if (!record) {
        pendingDowngradedToolCalls = undefined;
        continue;
      }
      if (record.role === "tool") {
        const toolCallId =
          typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
        if (!toolCallId) {
          continue;
        }
        const pendingCalls = pendingDowngradedToolCalls;
        if (!pendingCalls) {
          continue;
        }
        const toolNames = pendingCalls.get(toolCallId);
        if (!toolNames) {
          continue;
        }
        const toolName = toolNames.shift();
        if (!toolName) {
          continue;
        }
        if (toolNames.length === 0) {
          pendingCalls.delete(toolCallId);
        }
        const result = stringifyHistoricalValue(record.content);
        for (const key of Object.keys(record)) {
          delete record[key];
        }
        record.role = "user";
        record.content = `[Historical tool result for ${toolName}:\n${result}]`;
        continue;
      }
      pendingDowngradedToolCalls = undefined;
      if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
        continue;
      }

      // Tool-call ids are provider-local and can be reused on later turns. Match
      // signature metadata and result rewriting to this assistant occurrence.
      const historicalBatch = historicalToolCallBatches[historicalBatchIndex++];
      let shouldDowngradeBatch = false;
      const describedCalls: Array<{ id?: string; name: string; text: string }> = [];
      for (const [toolCallIndex, toolCall] of record.tool_calls.entries()) {
        const toolCallRecord = asOptionalObjectRecord(toolCall);
        if (!toolCallRecord) {
          continue;
        }
        const historicalCall = historicalBatch?.[toolCallIndex];
        const fn = asOptionalObjectRecord(toolCallRecord.function);
        const name = typeof fn?.name === "string" && fn.name.length > 0 ? fn.name : "unknown_tool";
        const args = stringifyHistoricalValue(fn?.arguments) || "{}";
        const describedCall = {
          ...(typeof toolCallRecord.id === "string" ? { id: toolCallRecord.id } : {}),
          name,
          text: `[Historical tool call: ${name}(${args})]`,
        };
        const signature =
          historicalCall &&
          historicalCall.id === toolCallRecord.id &&
          historicalCall.name === describedCall.name
            ? historicalCall.thoughtSignature
            : undefined;
        if (signature) {
          toolCallRecord.thought_signature = signature;
        } else if (requiresUnsignedCallFallback) {
          shouldDowngradeBatch = true;
        }
        describedCalls.push(describedCall);
      }
      if (!shouldDowngradeBatch) {
        continue;
      }
      pendingDowngradedToolCalls = new Map<string, string[]>();
      for (const call of describedCalls) {
        if (call.id) {
          const names = pendingDowngradedToolCalls.get(call.id) ?? [];
          names.push(call.name);
          pendingDowngradedToolCalls.set(call.id, names);
        }
      }
      const existingContent = stringifyHistoricalValue(record.content);
      record.content = [existingContent, ...describedCalls.map((call) => call.text)]
        .filter((part) => part.length > 0)
        .join("\n");
      delete record.tool_calls;
    }
  });
}
