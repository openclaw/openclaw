import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createPromptCacheRequestObserver,
  type PromptCacheRequestObservation,
} from "../prompt-cache-request-observer.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitted request cache observation", () => {
  it("observes canonical request prefixes before managed cache consumption and skips compaction", async () => {
    const { activeSession } = createSession();
    const observations = vi.fn<(observation: PromptCacheRequestObservation) => void>();
    const observer = createPromptCacheRequestObserver(
      { sessionId: "prompt-submit-cache-observer", streamStrategy: "test" },
      observations,
    );
    const observeRequest = vi.fn(
      (...args: Parameters<typeof observer.onModelRequest>): undefined => {
        observer.onModelRequest(...args);
      },
    );
    const provider: StreamFn = (model) =>
      createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }]));
    activeSession.agent.streamFn = (model, context, options) =>
      provider(model, { ...context, systemPrompt: undefined, tools: undefined }, options);
    const systemPrompt = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}stable suffix`;
    const tool = { name: "read", description: "Read text", parameters: Type.Object({}) };

    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      onModelRequest: observeRequest,
      promptActiveSession: async (_prompt, options) => {
        options?.preflightResult?.(true);
        for (const [index, cacheRead] of [10_000, 0, 10_000].entries()) {
          const response = await activeSession.agent.streamFn(testModel, {
            systemPrompt,
            messages: [],
            tools: [
              { ...tool, description: index === 2 ? "Read workspace text" : tool.description },
            ],
          });
          await response.result();
          observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
          if (index === 0) {
            activeSession.isCompacting = true;
            const compaction = await activeSession.agent.streamFn(testModel, {
              systemPrompt: "Summarize",
              messages: [],
              tools: [],
            });
            await compaction.result();
            activeSession.isCompacting = false;
          }
        }
      },
    });

    expect(observeRequest.mock.calls[0]?.[1]).toMatchObject({ systemPrompt, tools: [tool] });
    expect(observations.mock.calls.map(([observation]) => observation)).toMatchObject([
      { requestIndex: 1, messageCount: 0, broke: false, cacheRead: 10_000, changes: null },
      { requestIndex: 2, messageCount: 0, broke: true, cacheRead: 0, changes: null },
      {
        requestIndex: 3,
        messageCount: 0,
        broke: false,
        cacheRead: 10_000,
        changes: [{ code: "tools", detail: '1 -> 1 tools; description: "read"' }],
      },
    ]);
  });
});
