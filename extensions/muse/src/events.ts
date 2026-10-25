import type { FoldedItem, Session, Turn } from "@muse-code/sdk";
import {
  emitAgentHarnessAttemptEvent,
  makeZeroUsageSnapshot,
  racePromiseWithAbortSignal,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  embeddedAgentLog,
  projectAgentToolActivity,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
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
    usage: makeZeroUsageSnapshot(),
  };
}

export async function consumeTurn(
  turn: Turn,
  params: AgentHarnessAttemptParamsV2,
  record: (itemId: string, messages: AgentMessage[], historical: boolean) => Promise<void>,
  historicalItemIds: ReadonlySet<string> = new Set(),
) {
  const items = new Map<string, FoldedItem>();
  const streamed = new Map<string, string>();
  const emitted = new Map<string, number>();
  const settled = new Set<string>();
  const foregroundItems = new Set<string>();
  const toolStartedAt = new Map<string, number>();
  let answerRecorded = false;
  let finalizing = false;
  let visibleText = "";
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  let messageStarted = false;
  let streamQueue = Promise.resolve();
  let closed = false;
  const assertCurrent = () => {
    if (closed) {
      throw new Error("Muse turn projection is closed.");
    }
    params.abortSignal?.throwIfAborted();
    params.hostCapabilities.assertActive();
  };
  const emitEvent = (
    event: Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0],
  ) => {
    assertCurrent();
    return emitAgentHarnessAttemptEvent(params, event, { label: "Muse", log: embeddedAgentLog });
  };
  const noteProgress = (reason: string) => {
    assertCurrent();
    params.onRunProgress?.({ reason, provider: "meta", model: params.modelId, backend: "muse" });
  };
  const toolIdentity = (item: FoldedItem) => ({
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    toolCallId: item.callId ?? item.itemId,
    toolName: item.tool ?? "muse_tool",
  });
  const emitField = (item: FoldedItem, field: string, value: string, live = false) => {
    streamQueue = streamQueue.then(async () => {
      assertCurrent();
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
        if (live) {
          noteProgress("muse:assistant_message");
        }
        await emitEvent({ stream: "assistant", data: { itemId: item.itemId, delta, text: value } });
      } else if (item.kind === "reasoning" && (field === "text" || field.startsWith("summary."))) {
        await params.onReasoningStream?.({ text: delta });
      }
    });
    return streamQueue;
  };
  const deltaIterator = turn.deltas();
  const itemIterator = turn.items();
  const deltas = (async () => {
    for await (const delta of deltaIterator) {
      assertCurrent();
      const field = delta.field ?? "text";
      const key = `${delta.itemId}:${field}`;
      const value = (streamed.get(key) ?? "") + delta.delta;
      streamed.set(key, value);
      const item = items.get(delta.itemId);
      if (item && !historicalItemIds.has(item.itemId)) {
        await emitField(item, field, value, true);
      }
    }
  })();
  const projections = (async () => {
    for await (const item of itemIterator) {
      assertCurrent();
      const first = !items.has(item.itemId);
      const historical = historicalItemIds.has(item.itemId);
      items.set(item.itemId, item);
      if (!historical && item.kind !== "reminderChild" && item.kind !== "userMessage") {
        if (item.status === "inProgress") {
          foregroundItems.add(item.itemId);
        } else {
          foregroundItems.delete(item.itemId);
        }
        if (first) {
          answerRecorded = false;
          finalizing = false;
        }
      }
      // Post-answer reminder generation is Muse's background work, not another
      // model response. A completed text item alone cannot establish this: it
      // may be followed by foreground tools.
      if (
        first &&
        !historical &&
        item.kind === "reminderChild" &&
        item.status === "inProgress" &&
        answerRecorded &&
        foregroundItems.size === 0 &&
        !finalizing
      ) {
        await emitEvent({ stream: "lifecycle", data: { phase: "finishing" } });
        finalizing = true;
      }
      if (first && !historical) {
        for (const [key, value] of streamed) {
          if (key.startsWith(`${item.itemId}:`)) {
            await emitField(item, key.slice(item.itemId.length + 1), value, true);
          }
        }
      }
      if (item.kind === "toolCall" && first && !historical) {
        if (item.status === "inProgress") {
          toolStartedAt.set(item.itemId, Date.now());
          emitTrustedDiagnosticEvent({
            type: "tool.execution.started",
            ...toolIdentity(item),
          });
          noteProgress("muse:tool:started");
        }
        await emitEvent({
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
      assertCurrent();
      settled.add(item.itemId);
      const messages: AgentMessage[] = [];
      if (item.kind === "toolCall") {
        const startedAt = toolStartedAt.get(item.itemId);
        if (startedAt !== undefined) {
          toolStartedAt.delete(item.itemId);
          emitTrustedDiagnosticEvent({
            ...toolIdentity(item),
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(item.status === "completed"
              ? { type: "tool.execution.completed" as const }
              : { type: "tool.execution.error" as const, errorCategory: "muse_native_tool_error" }),
          });
          noteProgress("muse:tool:completed");
        }
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
        const resolution = !historical
          ? params.observeToolTerminal?.({
              toolCallId: id,
              toolName,
              arguments: args,
              result: item.visibleOutput,
              outcome: item.status === "completed" ? "success" : "failure",
              executionStarted: true,
              nativeMutation: { mutatingAction: true, replaySafe: false },
            })
          : undefined;
        if (!historical) {
          lastToolError = resolution?.lastToolError;
        }
        if (!historical) {
          params.onAgentToolResult?.({
            toolName,
            result: item.visibleOutput,
            isError: item.status !== "completed",
          });
        }
        if (!historical) {
          await emitEvent({
            stream: "item",
            data: projectAgentToolActivity({ toolCallId: id, name: toolName, phase: "result" }),
          });
        }
      } else if (item.kind === "agentMessage") {
        if (!historical) {
          await emitField(item, "text", item.text ?? "");
          // The completed item is authoritative; streamed deltas only drive live UI.
          visibleText += item.text ?? "";
        }
        messages.push(assistantMessage(params, [{ type: "text", text: item.text ?? "" }]));
      } else if (item.kind === "reasoning") {
        if (item.summary && !historical) {
          for (const [index, value] of item.summary.entries()) {
            await emitField(item, `summary.${index}`, value);
          }
        }
        messages.push(
          assistantMessage(params, [
            { type: "thinking", thinking: item.text ?? item.summary?.join("\n") ?? "" },
          ]),
        );
        assertCurrent();
        if (!historical) {
          await params.onReasoningEnd?.();
        }
      } else if (item.kind !== "userMessage" && !historical) {
        await emitEvent({
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
        assertCurrent();
        await record(item.itemId, messages, historical);
        if (item.kind === "agentMessage" && !historical) {
          answerRecorded = true;
        }
      }
    }
  })();
  try {
    await racePromiseWithAbortSignal(Promise.all([projections, deltas]), params.abortSignal);
    const outcome = await racePromiseWithAbortSignal(turn.completed, params.abortSignal);
    return { visibleText, lastToolError, outcome };
  } finally {
    // Detach observers without interrupting native work owned by another turn.
    closed = true;
    await Promise.allSettled([itemIterator.return?.(), deltaIterator.return?.()]);
  }
}

export async function recordMuseTranscriptGroup({
  params,
  target,
  nativeSessionId,
  itemId,
  group,
  historical,
}: {
  params: AgentHarnessAttemptParamsV2;
  target: { sessionId: string; sessionKey: string; storePath: string };
  nativeSessionId: string;
  itemId: string;
  group: AgentMessage[];
  historical: boolean;
}) {
  let finalKey: string | undefined;
  const entries = group.map((message, index) => {
    const idempotencyKey = `muse:${nativeSessionId}:${itemId}:${index}`;
    if (!historical && message.role === "assistant" && message.stopReason !== "toolUse") {
      finalKey = idempotencyKey;
    }
    return {
      message: {
        ...message,
        idempotencyKey,
        ...(!historical ? { __openclaw: { runId: params.runId } } : {}),
      },
      idempotencyLookup: "scan" as const,
    };
  });
  params.hostCapabilities.assertActive();
  params.abortSignal?.throwIfAborted();
  const written = await appendSessionTranscriptMessagesByIdentity({
    ...target,
    messages: entries,
    config: params.config,
  });
  if (written.length !== entries.length) {
    throw new Error("Muse transcript persistence rejected a native message group.");
  }
  const committed = written.at(-1);
  if (committed && !historical) {
    params.hostCapabilities.assertActive();
    params.abortSignal?.throwIfAborted();
    await publishSessionTranscriptUpdateByIdentity({
      ...target,
      update: {
        message: committed.message,
        messageId: committed.messageId,
        ...(committed.anchor ? { messageSeq: committed.anchor.activeMessagePosition + 1 } : {}),
        runId: params.runId,
        ...(committed.message.role === "assistant" ? { assistantItemIds: [itemId] } : {}),
      },
    });
  }
  params.abortSignal?.throwIfAborted();
  return finalKey;
}

export function projectMuseAttemptResult({
  params,
  messages,
  terminal,
  text,
  failed,
  assistantTranscriptOwned,
  finalKey,
  lastToolError,
}: {
  params: AgentHarnessAttemptParamsV2;
  messages: AgentMessage[];
  terminal: Extract<AgentHarnessAttemptResult, { terminal: unknown }>["terminal"];
  text: string;
  failed: boolean;
  assistantTranscriptOwned: boolean;
  finalKey: string | undefined;
  lastToolError: AgentHarnessAttemptResult["lastToolError"];
}): AgentHarnessAttemptResult {
  const toolMetas = messages
    .filter((message) => message.role === "toolResult")
    .map((message) => ({ toolName: message.toolName }));
  const lastAssistant = messages.findLast((message) => message.role === "assistant");
  return {
    terminal,
    assistantTexts: text ? [text] : [],
    messagesSnapshot: messages,
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    currentAttemptCompletedAssistant: failed ? undefined : lastAssistant,
    assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: finalKey,
    toolMetas,
    lastToolError,
    cloudCodeAssistFormatError: false,
    didSendViaMessagingTool: false,
    itemLifecycle: {
      activeCount: 0,
      completedCount: messages.length,
      startedCount: messages.length,
    },
    messagingToolSentTexts: [],
    messagingToolSentTargets: [],
    messagingToolSentMediaUrls: [],
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    yieldDetected: false,
    replayMetadata: {
      replaySafe: !failed && !params.initialReplayState?.replayInvalid && toolMetas.length === 0,
      hadPotentialSideEffects:
        params.initialReplayState?.hadPotentialSideEffects === true || toolMetas.length > 0,
    },
  };
}

export function collectMuseHistoricalItemIds(
  session: Session,
  detachedSessions: ReadonlySet<Session>,
) {
  return new Set(
    [
      session,
      ...[...detachedSessions].filter((previous) => previous.sessionId === session.sessionId),
    ]
      .flatMap((previous) => previous.fold.items.list())
      .filter((item) => item.status !== "inProgress")
      .map((item) => item.itemId),
  );
}

export function createMuseInput(
  params: AgentHarnessAttemptParamsV2,
  sessionContext: string,
): Parameters<Session["sendUserTurn"]>[0]["input"] {
  return [
    {
      type: "text",
      text: [sessionContext, params.extraSystemPrompt, params.prompt].filter(Boolean).join("\n\n"),
    },
    ...(params.images ?? []).map(
      (image): Parameters<Session["sendUserTurn"]>[0]["input"][number] => ({
        type: "image",
        mediaType: image.mimeType,
        base64Data: image.data,
      }),
    ),
  ];
}
