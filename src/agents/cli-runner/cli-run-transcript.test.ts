import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(() => resetGlobalHookRunner());

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
])(
  "preserves CLI $sourceTool output with its display policy after hooks",
  async ({ sourceTool, hidden }) => {
    const root = tempDirs.make("openclaw-cli-coordination-transcript-");
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
    } finally {
      unsubscribe();
    }
  },
);

it("keeps CLI usage unmarked when the backend reports no separate turn total", async () => {
  const root = tempDirs.make("openclaw-cli-usage-transcript-");
  const target = {
    agentId: "main",
    sessionId: "cli-usage-session",
    sessionKey: "agent:main:cli-usage",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });

  await persistCliAssistantTranscript({
    runParams: {
      ...target,
      sessionFile: `sqlite://agents/main/${target.sessionId}`,
      workspaceDir: root,
      prompt: "hi",
      provider: "codex-cli",
      runId: "cli-usage-run",
      timeoutMs: 1_000,
      persistAssistantTranscript: true,
    },
    text: "reply",
    modelId: "gpt-5.4",
    usage: { input: 10, output: 5, cacheRead: 100 },
    stopReason: "stop",
  });

  const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(messages).toHaveLength(1);
  // Without a separate turn total there is no proof the counters describe one model call.
  expect((messages[0] as AssistantMessage).usage).toEqual({
    input: 10,
    output: 5,
    cacheRead: 100,
    cacheWrite: 0,
    totalTokens: 115,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted", yielded: undefined, stopReason: "aborted" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = tempDirs.make("openclaw-cli-media-transcript-");
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

it("persists terminal cumulative usage with the latest-call context marker", async () => {
  const root = tempDirs.make("openclaw-cli-usage-transcript-");
  const target = {
    agentId: "main",
    sessionId: "cli-usage-session",
    sessionKey: "agent:main:cli-usage",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });

  const result = await persistCliAssistantTranscript({
    runParams: {
      ...target,
      sessionFile: `sqlite://agents/main/${target.sessionId}`,
      workspaceDir: root,
      prompt: "use the terminal total",
      provider: "claude-cli",
      runId: "cli-usage-run",
      timeoutMs: 1_000,
      persistAssistantTranscript: true,
    },
    text: "final answer",
    modelId: "claude-sonnet-4-6",
    usage: { input: 30, output: 15, cacheRead: 300, cacheWrite: 12, total: 357 },
    turnUsage: { input: 70, output: 30, cacheRead: 500, cacheWrite: 20, total: 620 },
    stopReason: "stop",
  });

  expect(result.owned).toBe(true);
  const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    usage: {
      input: 70,
      output: 30,
      cacheRead: 500,
      cacheWrite: 20,
      totalTokens: 620,
      contextUsage: { state: "available", promptTokens: 342, totalTokens: 357 },
    },
  });
});
