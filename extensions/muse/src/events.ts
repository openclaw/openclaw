import type { FoldedItem, Turn } from "@muse-code/sdk";
import {
  projectAgentToolActivity,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type MuseAssistant = Extract<AgentMessage, { role: "assistant" }>;

function assistantMessage(
  params: AgentHarnessAttemptParamsV2,
  content: MuseAssistant["content"],
  stopReason: MuseAssistant["stopReason"] = "stop",
): MuseAssistant {
  return {
    role: "assistant",
    api: params.model.api,
    provider: "meta",
    model: params.modelId,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export async function consumeTurn(
  turn: Turn,
  params: AgentHarnessAttemptParamsV2,
  record: (itemId: string, messages: AgentMessage[]) => Promise<void>,
) {
  const items = new Map<string, FoldedItem>();
  const streamed = new Map<string, string>();
  const emitted = new Map<string, number>();
  const settled = new Set<string>();
  let visibleText = "";
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  let messageStarted = false;
  let streamQueue = Promise.resolve();
  const emitField = (item: FoldedItem, field: string, value: string) => {
    streamQueue = streamQueue.then(async () => {
      const key = `${item.itemId}:${field}`;
      const offset = emitted.get(key) ?? 0;
      if (value.length <= offset) {
        return;
      }
      const delta = value.slice(offset);
      emitted.set(key, value.length);
      if (item.kind === "agentMessage" && field === "text") {
        if (!messageStarted) {
          messageStarted = true;
          await params.onAssistantMessageStart?.();
        }
        await params.onAgentEvent?.({ stream: "assistant", data: { delta, text: value } });
      } else if (item.kind === "reasoning" && (field === "text" || field.startsWith("summary."))) {
        await params.onReasoningStream?.({ text: delta });
      }
    });
    return streamQueue;
  };
  const deltas = (async () => {
    for await (const delta of turn.deltas()) {
      const field = delta.field ?? "text";
      const key = `${delta.itemId}:${field}`;
      const value = (streamed.get(key) ?? "") + delta.delta;
      streamed.set(key, value);
      const item = items.get(delta.itemId);
      if (item) {
        await emitField(item, field, value);
      }
    }
  })();
  const projections = (async () => {
    for await (const item of turn.items()) {
      const first = !items.has(item.itemId);
      items.set(item.itemId, item);
      if (first) {
        for (const [key, value] of streamed) {
          if (key.startsWith(`${item.itemId}:`)) {
            await emitField(item, key.slice(item.itemId.length + 1), value);
          }
        }
      }
      if (item.kind === "toolCall" && first) {
        await params.onAgentEvent?.({
          stream: "item",
          data: projectAgentToolActivity({
            toolCallId: item.callId ?? item.itemId,
            name: item.tool ?? "muse_tool",
            phase: "start",
          }),
        });
      }
      if (item.status === "inProgress" || settled.has(item.itemId)) {
        continue;
      }
      settled.add(item.itemId);
      const messages: AgentMessage[] = [];
      if (item.kind === "toolCall") {
        const toolName = item.tool ?? "muse_tool";
        let args: Record<string, unknown> = {};
        if (item.args) {
          try {
            const decoded: unknown = JSON.parse(item.args);
            args = isRecord(decoded) ? decoded : { rawArgs: item.args };
          } catch {
            args = { rawArgs: item.args };
          }
        }
        const id = item.callId ?? item.itemId;
        messages.push(
          assistantMessage(
            params,
            [{ type: "toolCall", id, name: toolName, arguments: args }],
            "toolUse",
          ),
        );
        messages.push({
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text: item.visibleOutput ?? item.failureReason ?? "" }],
          isError: item.status !== "completed",
          timestamp: Date.now(),
        });
        const resolution = params.observeToolTerminal?.({
          toolCallId: id,
          toolName,
          arguments: args,
          result: item.visibleOutput,
          outcome: item.status === "completed" ? "success" : "failure",
          executionStarted: true,
          nativeMutation: { mutatingAction: true, replaySafe: false },
        });
        lastToolError = resolution?.lastToolError;
        params.onAgentToolResult?.({
          toolName,
          result: item.visibleOutput,
          isError: item.status !== "completed",
        });
        await params.onAgentEvent?.({
          stream: "item",
          data: projectAgentToolActivity({ toolCallId: id, name: toolName, phase: "result" }),
        });
      } else if (item.kind === "agentMessage") {
        await emitField(item, "text", item.text ?? "");
        // The completed item is authoritative; streamed deltas only drive live UI.
        visibleText += item.text ?? "";
        messages.push(assistantMessage(params, [{ type: "text", text: item.text ?? "" }]));
      } else if (item.kind === "reasoning") {
        if (item.summary) {
          for (const [index, value] of item.summary.entries()) {
            await emitField(item, `summary.${index}`, value);
          }
        }
        messages.push(
          assistantMessage(params, [
            { type: "thinking", thinking: item.text ?? item.summary?.join("\n") ?? "" },
          ]),
        );
        await params.onReasoningEnd?.();
      } else if (item.kind !== "userMessage") {
        await params.onAgentEvent?.({
          stream: "item",
          data: {
            type: String(item.kind),
            status: String(item.status),
            text: item.fallbackText ?? String(item.kind),
            id: item.itemId,
          },
        });
      }
      if (messages.length) {
        await record(item.itemId, messages);
      }
    }
  })();
  await Promise.all([projections, deltas]);
  return { visibleText, lastToolError, outcome: await turn.completed };
}
