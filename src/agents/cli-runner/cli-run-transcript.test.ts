import path from "node:path";
import { afterAll, afterEach, expect, it, onTestFinished } from "vitest";
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
  const runParams = {
    ...target,
    provider: "claude-cli",
    runId: `cli-${name}-run`,
    config: {},
    sessionFile: `sqlite://agents/main/${sessionId}`,
    workspaceDir: root,
    prompt: "hi",
    timeoutMs: 1_000,
    persistAssistantTranscript: true,
  };
  const updates: InternalSessionTranscriptUpdate[] = [];
  onTestFinished(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
  return {
    target,
    runParams,
    updates,
    persist: (overrides: Partial<Parameters<typeof persistCliAssistantTranscript>[0]>) =>
      persistCliAssistantTranscript({
        runParams,
        text: "reply",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
        ...overrides,
      }),
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
    const { target, runParams, persist, updates } = await transcriptFixture("coordination");
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
    const text = "The worker result passed validation";
    const result = await persist({
      runParams: {
        ...runParams,
        privateCompletion,
        inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
      },
      text,
    });
    expect(result.owned).toBe(true);
    const messages = await transcriptMessages(target);
    expect(messages).toMatchObject([{ role: "assistant", content: [{ type: "text", text }] }]);
    expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
    expect(updates).toHaveLength(1);
    expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
    expect(readSessionTranscriptRunId(updates[0]!.message)).toBe("cli-coordination-run");
  },
);

it.each([false, true])("persists CLI usage with separate turn total=%s", async (turnTotal) => {
  const { target, runParams, persist } = await transcriptFixture("usage");
  const cacheUsage = { input: 4418, output: 5, cacheWrite: 36955, cacheWrite1h: 36955 };
  await persist({
    runParams: { ...runParams, provider: turnTotal ? "claude-cli" : "codex-cli" },
    modelId: turnTotal ? "claude-opus-4-8" : "gpt-5.4",
    usage: turnTotal ? cacheUsage : { input: 10, output: 5, cacheRead: 100 },
    ...(turnTotal ? { turnUsage: { ...cacheUsage, output: 534 } } : {}),
  });
  const messages = await transcriptMessages(target);
  expect(messages).toHaveLength(1);
  expect((messages[0] as AssistantMessage).usage).toEqual(
    turnTotal
      ? expect.objectContaining({ output: 534, cacheWrite: 36955, cacheWrite1h: 36955 })
      : expect.objectContaining({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }),
  );
});

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const { target, runParams, persist, updates } = await transcriptFixture("media");
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const result = await persist({
      runParams: {
        ...runParams,
        prepareAssistantTranscriptMessage: (message) =>
          applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
      },
      text: sourceText,
      stopReason,
      yielded,
    });
    expect(result).toMatchObject({ owned: true, idempotencyKey: "cli-assistant:cli-media-run" });
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
