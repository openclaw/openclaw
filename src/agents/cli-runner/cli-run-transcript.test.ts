import path from "node:path";
import { afterAll, afterEach, expect, it, onTestFinished, vi } from "vitest";
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

async function transcriptFixture(name: string) {
  const sessionId = `cli-${name}-session`;
  const sessionKey = `agent:main:cli-${name}`;
  const root = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  return {
    target,
    runParams: {
      ...target,
      provider: "claude-cli",
      runId: `cli-${name}-run`,
      config: {},
      sessionFile: `sqlite://agents/main/${sessionId}`,
      workspaceDir: root,
      prompt: "hi",
      timeoutMs: 1_000,
      persistAssistantTranscript: true,
    },
  };
}

async function transcriptMessages(target: Parameters<typeof loadTranscriptEvents>[0]) {
  return (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
}

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
  { sourceTool: "subagent_announce", privateCompletion: true as const, hidden: true },
  { sourceTool: "subagent_settle", privateCompletion: true as const, hidden: true },
])(
  "preserves CLI $sourceTool output with its display policy after hooks (private=$privateCompletion)",
  async ({ sourceTool, hidden, privateCompletion }) => {
    const { target, runParams } = await transcriptFixture("coordination");
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
    onTestFinished(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
    const result = await persistCliAssistantTranscript({
      runParams: {
        ...runParams,
        prompt: "Review the worker result",
        privateCompletion,
        inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
      },
      text: "The worker result passed validation",
      modelId: "claude-sonnet-4-6",
      stopReason: "stop",
    });
    expect(result.owned).toBe(true);
    const messages = await transcriptMessages(target);
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
  },
);

it("keeps CLI usage unmarked when the backend reports no separate turn total", async () => {
  const { target, runParams } = await transcriptFixture("usage");

  await persistCliAssistantTranscript({
    runParams: {
      ...runParams,
      provider: "codex-cli",
    },
    text: "reply",
    modelId: "gpt-5.4",
    usage: { input: 10, output: 5, cacheRead: 100 },
    stopReason: "stop",
  });

  const messages = await transcriptMessages(target);
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

it("persists the 1h cache-write subset of a Claude turn total", async () => {
  const { target, runParams } = await transcriptFixture("cache-ttl");

  await persistCliAssistantTranscript({
    runParams,
    text: "reply",
    modelId: "claude-opus-4-8",
    usage: { input: 4418, output: 5, cacheWrite: 36955, cacheWrite1h: 36955 },
    turnUsage: { input: 4418, output: 534, cacheWrite: 36955, cacheWrite1h: 36955 },
    stopReason: "stop",
  });

  const messages = await transcriptMessages(target);
  // Usage estimates price 1h writes at twice the input rate, so the subset must survive.
  expect((messages[0] as AssistantMessage).usage).toMatchObject({
    output: 534,
    cacheWrite: 36955,
    cacheWrite1h: 36955,
  });
});

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const { target, runParams } = await transcriptFixture("media");
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    onTestFinished(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
    const result = await persistCliAssistantTranscript({
      runParams: {
        ...runParams,
        prompt: "make an artifact",
        prepareAssistantTranscriptMessage,
      },
      text: sourceText,
      modelId: "claude-sonnet-4-6",
      stopReason,
      yielded,
    });
    expect(result.owned).toBe(true);
    expect(result.idempotencyKey).toBe("cli-assistant:cli-media-run");
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
    const messages = await transcriptMessages(target);
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
  },
);
