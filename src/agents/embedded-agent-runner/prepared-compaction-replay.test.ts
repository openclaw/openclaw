import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { Message } from "../../llm/types.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { buildBeforeCompactionHookMetrics } from "./compaction-hook-metrics.js";
import { limitHistoryTurns } from "./history.js";
import { prepareNativeCompactionReplay } from "./prepared-compaction-replay.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";

const model = makeProviderModelFixture<"openai-completions">({
  id: "synthetic-model",
  api: "openai-completions",
  provider: "synthetic-provider",
  baseUrl: "https://synthetic-provider.example/v1",
});
const policy = resolveTranscriptPolicy({
  model,
  modelApi: model.api,
  provider: model.provider,
  modelId: model.id,
});

async function source(messages: Message[]) {
  const manager = SessionManager.inMemory();
  for (const message of messages) {
    await manager.appendMessageAsync(message);
  }
  return manager;
}

describe("native prepared compaction replay", () => {
  it("matches session replay metrics after cleanup, retry deduplication and history limiting", async () => {
    const prompt = "Preserve the synthetic deployment checklist for this request";
    const messages: Message[] = [];
    for (let index = 0; index < 4; index++) {
      messages.push({ role: "user", content: prompt + index, timestamp: index * 10000 });
      if (index === 0) {
        messages.push({ role: "user", content: prompt + index, timestamp: 1000 });
      }
      messages.push(
        makeAssistantMessageFixture({
          provider: model.provider,
          api: model.api,
          model: model.id,
          content: [{ type: "text", text: "Acknowledged " + index }],
          stopReason: "stop",
        }),
      );
    }
    messages.push(makeAssistantMessageFixture({ content: [], stopReason: "error" }));
    const manager = await source(messages);
    const entries = manager.getBranch();
    const replayContext = {
      model,
      modelApi: model.api,
      modelId: model.id,
      provider: model.provider,
      policy,
      sessionId: manager.getSessionId(),
    };
    const sanitized = await sanitizeSessionHistory({
      ...replayContext,
      sessionManager: manager,
      messages: sanitizeCompactionReplayMessages(buildSessionContext(entries).messages),
      allowedToolNames: [],
      preserveLatestAssistantThinking: false,
    });
    const originalMessages = dedupeDuplicateUserMessagesForCompaction(
      await validateReplayTurns({ ...replayContext, messages: sanitized }),
    );
    const currentMessages = limitHistoryTurns(originalMessages, 1);
    const actual = await prepareNativeCompactionReplay(entries, {
      model,
      policy,
      sessionId: manager.getSessionId(),
      allowedToolNames: [],
      imageLimits: {},
      historyLimit: 1,
      replayEnabled: false,
      observedTokenCount: 1234,
    });
    expect(actual.beforeHookMetrics).toEqual(
      buildBeforeCompactionHookMetrics({
        originalMessages,
        currentMessages,
        observedTokenCount: 1234,
        estimateTokensFn: estimateTokens,
      }),
    );
    expect(actual.beforeHookMetrics).toMatchObject({
      messageCountOriginal: 8,
      messageCountBefore: 4,
      tokenCountBefore: 1234,
    });
    expect(actual.hasRealConversation).toBe(true);
    expect(actual.modelSnapshot).toMatchObject({ provider: model.provider, modelId: model.id });
    expect(actual).not.toHaveProperty("messages");
  });

  it("keeps heartbeat-only replay a no-op", async () => {
    const manager = await source([{ role: "user", content: "HEARTBEAT_OK", timestamp: 1 }]);
    const actual = await prepareNativeCompactionReplay(manager.getBranch(), {
      model,
      policy,
      sessionId: manager.getSessionId(),
      allowedToolNames: [],
      imageLimits: {},
      replayEnabled: false,
    });
    expect(actual.hasRealConversation).toBe(false);
  });
});
