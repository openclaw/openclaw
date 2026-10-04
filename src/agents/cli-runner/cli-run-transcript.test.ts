import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-coordination-transcript-");
afterEach(() => resetGlobalHookRunner());

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
])(
  "preserves CLI $sourceTool output with its display policy after hooks",
  async ({ sourceTool, hidden }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-coordination-session",
      sessionKey: "agent:main:cli-coordination",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-output",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => ({
        message: { ...message, display: true },
      }),
    });
    initializeGlobalHookRunner(registry);
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "Review the worker result",
          provider: "claude-cli",
          runId: "cli-coordination-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
        },
        text: "The worker result passed validation",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
      });
      expect(result.owned).toBe(true);
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: "The worker result passed validation" }],
        },
      ]);
      expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
      expect(updates).toHaveLength(1);
      expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
      expect(readSessionTranscriptRunId(updates[0]!.message)).toBe("cli-coordination-run");
    } finally {
      unsubscribe();
    }
  },
);

it("persists a completed CLI segment once before its distinct final reply", async () => {
  const root = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId: "cli-segment-session",
    sessionKey: "agent:main:cli-segments",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const runParams = {
    ...target,
    sessionFile: `sqlite://agents/main/${target.sessionId}`,
    workspaceDir: root,
    prompt: "Explain, then check a tool",
    provider: "claude-cli",
    runId: "cli-segment-run",
    timeoutMs: 1_000,
    persistAssistantTranscript: true,
  };
  const segment = {
    runParams,
    text: "The answer is here.",
    modelId: "claude-sonnet-4-6",
    stopReason: "stop" as const,
    segmentKey: "message-1:0",
    timestamp: 1_790_000_000_000,
    nativeEntry: { entryId: "native-entry-1", sessionId: "native-session-1" },
  };
  await persistCliAssistantTranscript(segment);
  await persistCliAssistantTranscript(segment);
  await persistCliAssistantTranscript({
    runParams,
    text: "Final answer.",
    modelId: segment.modelId,
    stopReason: "stop",
  });
  const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(messages).toMatchObject([
    {
      content: [{ type: "text", text: "The answer is here." }],
      timestamp: segment.timestamp,
      idempotencyKey: "cli-assistant:cli-segment-run:seg:message-1:0",
      __openclaw: {
        cliNativeRef: {
          externalId: "native-entry-1",
          importedFrom: "claude-cli",
          cliSessionId: "native-session-1",
        },
      },
    },
    {
      content: [{ type: "text", text: "Final answer." }],
      idempotencyKey: "cli-assistant:cli-segment-run",
    },
  ]);
});

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-media-session",
      sessionKey: "agent:main:cli-media",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "make an artifact",
          provider: "claude-cli",
          runId: "cli-media-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage,
        },
        text: sourceText,
        modelId: "claude-sonnet-4-6",
        stopReason,
        yielded,
      });
      expect(result.owned).toBe(true);
      expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: [{ type: "text", text: sourceText }] }),
        sourceText,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: sourceText }],
        idempotencyKey: result.idempotencyKey,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
        yielded === true && stopReason === "stop",
      );
      expect(messages[0]).toMatchObject({ stopReason });
      if (yielded && stopReason === "stop") {
        expect(messages[0]).toMatchObject({
          openclawStreamFallback: {
            replacementText: sourceText,
            source: "segment",
            itemId: "cli-media-run",
          },
        });
      } else {
        expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
      }
      expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
        { content: [{ type: "text", text: "Artifacts ready" }] },
      ]);
    } finally {
      unsubscribe();
    }
  },
);
