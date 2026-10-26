import assert from "node:assert/strict";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createPromptCacheRequestObserver } from "../prompt-cache-request-observer.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

it("rechecks request authority after asynchronous observation before dispatch", async () => {
  const { activeSession } = createSession();
  const provider = vi.fn<StreamFn>();
  activeSession.agent.streamFn = provider;
  let active = true;
  await expect(
    submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      assertHostActive: () => assert(active, "request revoked"),
      onModelRequest: async () => {
        active = false;
        return undefined;
      },
      promptActiveSession: async (_prompt, options) => {
        options?.preflightResult?.(true);
        await activeSession.agent.streamFn(testModel, { messages: [] });
      },
    }),
  ).rejects.toThrow("request revoked");
  expect(provider).not.toHaveBeenCalled();
});

it("observes canonical request prefixes before managed cache consumption and skips compaction", async () => {
  const { activeSession } = createSession();
  const observations = vi.fn<Parameters<typeof createPromptCacheRequestObserver>[1]>();
  const observer = createPromptCacheRequestObserver(
    { sessionId: "prompt-submit-cache-observer", streamStrategy: "test" },
    observations,
  );
  const observeRequest = vi.fn(
    async (...args: Parameters<typeof observer.onModelRequest>): Promise<undefined> => {
      await observer.onModelRequest(...args);
    },
  );
  const provider: StreamFn = (model) =>
    createAssistantResultStream(createAssistant(model, "Done."));
  activeSession.agent.streamFn = (model, context, options) =>
    provider(model, { ...context, systemPrompt: undefined, tools: undefined }, options);
  const systemPrompt = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}stable suffix`;
  const tool = { name: "read", description: "Read text", parameters: Type.Object({}) };
  const cases = [
    [10_000, false, null],
    [0, true, null],
    [10_000, false, [{ code: "tools", detail: '1 -> 1 tools; description: "read"' }]],
  ] as const;

  await submitEmbeddedAttemptPrompt({
    ...createBaseInput(),
    activeSession,
    onModelRequest: observeRequest,
    promptActiveSession: async (_prompt, options) => {
      options?.preflightResult?.(true);
      const request = async (context: Parameters<StreamFn>[1]) =>
        (await activeSession.agent.streamFn(testModel, context)).result();
      for (const [index, [cacheRead, broke, changes]] of cases.entries()) {
        await request({
          systemPrompt,
          messages: [],
          tools: [{ ...tool, description: index === 2 ? "Read workspace text" : tool.description }],
        });
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
        const expected = { requestIndex: index + 1, messageCount: 0, broke, cacheRead, changes };
        expect(observations).toHaveBeenCalledTimes(index + 1);
        expect(observations.mock.lastCall?.[0]).toMatchObject(expected);
        if (index === 0) {
          activeSession.isCompacting = true;
          await request({ systemPrompt: "Summarize", messages: [], tools: [] });
          activeSession.isCompacting = false;
        }
      }
    },
  });

  expect(observeRequest.mock.calls[0]?.[1]).toMatchObject({ systemPrompt, tools: [tool] });
});
