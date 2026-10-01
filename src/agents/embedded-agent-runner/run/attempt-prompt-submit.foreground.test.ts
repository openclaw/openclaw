import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt foreground dispatch", () => {
  it("observes only foreground dispatch and keeps compaction out of restoration", async () => {
    const { activeSession } = createSession();
    const captures: Context[] = [];
    const stream: StreamFn = (_model, context) => {
      captures.push(context);
      return createAssistantResultStream(createAssistant(testModel, []));
    };
    activeSession.agent.streamFn = stream;
    const restoredTools = [
      { name: "message", description: "required", parameters: { type: "object" as const } },
    ];
    let changed = false;
    const prepare = vi.fn(() =>
      changed
        ? Promise.resolve(() => ({ tools: restoredTools, systemPrompt: "restored" }))
        : undefined,
    );
    const observe = vi.fn();
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      onPrimaryModelRequest: observe,
      preparePrimaryModelRequest: prepare,
      promptActiveSession: async (_prompt, options) => {
        const request = (systemPrompt: string) =>
          activeSession.agent.streamFn(testModel, { messages: [], tools: [], systemPrompt }, {});
        await request("preflight");
        expect(observe).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        options?.preflightResult?.(true);
        await request("filtered");
        prepare.mockClear();
        changed = true;
        activeSession.isCompacting = true;
        await request("compaction");
        expect(prepare).not.toHaveBeenCalled();
        activeSession.isCompacting = false;
        await request("filtered");
      },
    });
    expect(captures.map(({ tools, systemPrompt }) => ({ tools, systemPrompt }))).toEqual([
      { tools: [], systemPrompt: "preflight" },
      { tools: [], systemPrompt: "filtered" },
      { tools: [], systemPrompt: "compaction" },
      { tools: restoredTools, systemPrompt: "restored" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledExactlyOnceWith([]);
    expect(activeSession.agent.streamFn).toBe(stream);
  });

  it("rechecks authority after awaiting restoration, before callbacks or dispatch", async () => {
    const { activeSession } = createSession();
    const stream = vi.fn<StreamFn>();
    activeSession.agent.streamFn = stream;
    let active = true;
    const reader = vi.fn(() => ({ tools: [], systemPrompt: "restored" }));
    const observe = vi.fn();
    await expect(
      submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        onPrimaryModelRequest: observe,
        assertHostActive: () => {
          if (!active) {
            throw new Error("authority closed");
          }
        },
        preparePrimaryModelRequest: async () => {
          active = false;
          return reader;
        },
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(true);
          await activeSession.agent.streamFn(testModel, { messages: [] }, {});
        },
      }),
    ).rejects.toThrow("authority closed");
    expect(reader).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(["preflight", "aborted"])(
    "does not report applied filtering for %s-only submission",
    async (kind) => {
      const { activeSession } = createSession();
      const observe = vi.fn();
      const execute = submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        onPrimaryModelRequest: observe,
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(kind !== "preflight");
          if (kind === "aborted") {
            await activeSession.agent.streamFn(
              testModel,
              { messages: [] },
              { signal: AbortSignal.abort(new Error("cancelled")) },
            );
          }
        },
      });
      if (kind === "aborted") {
        await expect(execute).rejects.toThrow("cancelled");
      } else {
        await execute;
      }
      expect(observe).not.toHaveBeenCalled();
    },
  );
});
