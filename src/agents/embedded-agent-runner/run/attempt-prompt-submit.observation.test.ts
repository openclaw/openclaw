import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageContent } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
const sessionId = "attempt-prompt-submit-observation-test";
function createSession() {
  const state = {
    messages: [{ role: "user", content: "transcript prompt", timestamp: 1 }] as AgentMessage[],
  };
  const baseStreamFn: StreamFn = () => {
    throw new Error("stream function should not be called directly");
  };
  const originalTransformContext = async (messages: AgentMessage[]) => messages;
  const agent = {
    state,
    streamFn: baseStreamFn,
    transformContext: originalTransformContext,
    reset: () => {
      state.messages = [];
    },
  };
  const activeSession = {
    isCompacting: false,
    [agentSessionQueuePromptContext]: vi.fn(() => () => undefined),
    get messages() {
      return state.messages;
    },
    agent,
  };
  return { activeSession, baseStreamFn, originalTransformContext };
}

function createBaseInput() {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { sessionId },
    appendContext: "append context",
    contextTokenBudget: 8_000,
    images: [] as ImageContent[],
    modelPrompt: "model prompt",
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    persistToolResultProjections: vi.fn(async () => {}),
    prependContext: "prepend context",
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "system prompt",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    transcriptPrompt: "transcript prompt",
  };
}

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));
describe("primary submission observation", () => {
  it("observes only the first admitted foreground tool definitions, not compaction or later loop requests", async () => {
    const { activeSession } = createSession();
    const stream = vi.fn(() =>
      createAssistantResultStream(createAssistant(testModel, [{ type: "text", text: "ok" }])),
    );
    activeSession.agent.streamFn = stream;
    const observe = vi.fn();
    const tools = [
      {
        name: "message",
        description: "visible",
        parameters: { type: "object" as const, properties: {} },
      },
    ];
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      onPrimaryModelRequest: observe,
      promptActiveSession: async (_prompt, options) => {
        await activeSession.agent.streamFn(testModel, { messages: [] }, {});
        expect(observe).not.toHaveBeenCalled();
        options?.preflightResult?.(true);
        await activeSession.agent.streamFn(testModel, { messages: [], tools }, {});
        await activeSession.agent.streamFn(testModel, { messages: [], tools: [] }, {});
      },
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith(tools);
    expect(activeSession.agent.streamFn).toBe(stream);
  });
  it("leaves mid-turn compaction context intact and restores only the next foreground request", async () => {
    const { activeSession } = createSession();
    const captures: Array<Parameters<StreamFn>[1]> = [];
    activeSession.agent.streamFn = (_model, context) => {
      captures.push(context);
      return createAssistantResultStream(createAssistant(testModel, []));
    };
    let changed = false;
    const restoredTools = [
      {
        name: "permitted",
        description: "restored",
        parameters: { type: "object" as const, properties: {} },
      },
    ];
    const prepare = vi.fn(() =>
      changed
        ? Promise.resolve(() => ({ tools: restoredTools, systemPrompt: "ordinary prompt" }))
        : undefined,
    );
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      preparePrimaryModelRequest: prepare,
      promptActiveSession: async (_prompt, options) => {
        options?.preflightResult?.(true);
        await activeSession.agent.streamFn(
          testModel,
          { messages: [], tools: [], systemPrompt: "filtered prompt" },
          {},
        );
        prepare.mockClear();
        changed = true;
        activeSession.isCompacting = true;
        await activeSession.agent.streamFn(
          testModel,
          { messages: [], tools: [], systemPrompt: "compaction prompt" },
          {},
        );
        expect(prepare).not.toHaveBeenCalled();
        activeSession.isCompacting = false;
        await activeSession.agent.streamFn(
          testModel,
          { messages: [], tools: [], systemPrompt: "filtered prompt" },
          {},
        );
      },
    });
    expect(
      captures.map((context) => ({ tools: context.tools, systemPrompt: context.systemPrompt })),
    ).toEqual([
      { tools: [], systemPrompt: "filtered prompt" },
      { tools: [], systemPrompt: "compaction prompt" },
      { tools: restoredTools, systemPrompt: "ordinary prompt" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rechecks authority after restoration preparation (closed=%s)",
    async (closed) => {
      const { activeSession } = createSession();
      const stream = vi.fn<StreamFn>(() =>
        createAssistantResultStream(createAssistant(testModel, [])),
      );
      activeSession.agent.streamFn = stream;
      let active = true;
      const ordinary = [
        {
          name: "restored",
          description: "permitted",
          parameters: { type: "object" as const, properties: {} },
        },
      ];
      const reader = vi.fn(() => ({ tools: ordinary, systemPrompt: "restored prompt" }));
      const prepare = vi.fn(async () => {
        active = !closed;
        return reader;
      });
      const execute = submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        assertHostActive: () => {
          if (!active) {
            throw new Error("authority closed");
          }
        },
        preparePrimaryModelRequest: prepare,
        promptActiveSession: async (_prompt, options) => {
          await activeSession.agent.streamFn(testModel, { messages: [] }, {});
          expect(prepare).not.toHaveBeenCalled();
          stream.mockClear();
          options?.preflightResult?.(true);
          await activeSession.agent.streamFn(testModel, { messages: [], tools: [] }, {});
        },
      });
      if (closed) {
        await expect(execute).rejects.toThrow("authority closed");
        expect(reader).not.toHaveBeenCalled();
        expect(stream).not.toHaveBeenCalled();
      } else {
        await execute;
        expect(reader).toHaveBeenCalledOnce();
        expect(stream.mock.calls[0]?.[1]).toMatchObject({
          tools: ordinary,
          systemPrompt: "restored prompt",
        });
      }
    },
  );

  it.each(["preflight", "aborted"])(
    "does not report applied filtering for %s-only submission",
    async (kind) => {
      const { activeSession } = createSession();
      activeSession.agent.streamFn = vi.fn(() =>
        createAssistantResultStream(createAssistant(testModel, [])),
      );
      const observe = vi.fn();
      const execute = submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        onPrimaryModelRequest: observe,
        promptActiveSession: async (_prompt, options) => {
          if (kind === "preflight") {
            options?.preflightResult?.(false);
            return;
          }
          options?.preflightResult?.(true);
          const controller = new AbortController();
          controller.abort(new Error("cancelled"));
          await activeSession.agent.streamFn(
            testModel,
            { messages: [] },
            { signal: controller.signal },
          );
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
