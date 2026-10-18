import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { buildTimestampPrefix } from "../../gateway/server-methods/agent-timestamp.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import { createUserTranscriptContextRegistry } from "../embedded-agent-runner/run/attempt-user-transcript-context-registry.js";
import {
  attachSteeringRuntimeContext,
  setSteeringRuntimeContextRetention,
} from "../embedded-agent-runner/run/runtime-context-prompt.js";
import type { AgentTool } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "./agent-session-prompting.js";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const imageQueues = [
  {
    kind: "steering",
    queue: (session: AgentSession) => session.steer("", [image]),
    messages: (session: AgentSession) => session.getSteeringMessages(),
    initialQueue: { steering: [""], followUp: [] },
  },
  {
    kind: "follow-up",
    queue: (session: AgentSession) => session.followUp("", [image]),
    messages: (session: AgentSession) => session.getFollowUpMessages(),
    initialQueue: { steering: [], followUp: [""] },
  },
];
const toolResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const makeTool = (
  name: string,
  execute: ToolDefinition["execute"] = async () => toolResult("done"),
): ToolDefinition => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute,
});
const textStream = (model: Model, text = "done") =>
  createAssistantResultStream(createAssistant(model, [{ type: "text", text }]));
const handlersFor = (handlers: Record<string, () => Promise<unknown>>) =>
  new Map(Object.entries(handlers).map(([name, handler]) => [name, [handler]]));

function heldResponse(model: Model, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  signal?.addEventListener(
    "abort",
    () => {
      stream.push({
        type: "error",
        reason: "aborted",
        error: createAssistant(model, [], "aborted"),
      });
      stream.end();
    },
    { once: true },
  );
  return {
    stream,
    finish: (text: string) => {
      stream.push({
        type: "done",
        reason: "stop",
        message: createAssistant(model, [{ type: "text", text }]),
      });
      stream.end();
    },
  };
}

function mockHeldRun(nextAnswer: string) {
  const requests: Context[] = [];
  let finish: (() => void) | undefined;
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push(context);
    if (requests.length > 1) {
      return textStream(model, nextAnswer);
    }
    const response = heldResponse(model);
    finish = () => response.finish("first answer");
    return response.stream;
  });
  return { requests, finish: () => finish?.() };
}

type QueuedMessage = Parameters<AgentSession["agent"]["steer"]>[0];
function queuedState(session: AgentSession) {
  const queues = session.agent as unknown as Record<
    "steeringQueue" | "followUpQueue",
    { messages: QueuedMessage[] }
  >;
  const handleAgentEvent = Reflect.get(session, "handleAgentEvent") as (event: {
    type: "message_start";
    message: QueuedMessage;
  }) => Promise<void>;
  return {
    queues,
    start: (message: QueuedMessage) => handleAgentEvent({ type: "message_start", message }),
  };
}

function mockAbortableQueuedRun() {
  const executeTool = vi.fn();
  const requests: Array<{ context: Context; signal: AbortSignal | undefined }> = [];
  const tool = makeTool("queued_action", async () => {
    executeTool();
    return toolResult("action completed");
  });

  streamMocks.streamSimple.mockImplementation(
    (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
      const requestIndex = requests.length;
      requests.push({ context, signal: options?.signal });
      if (requestIndex === 0) {
        return heldResponse(activeModel, options?.signal).stream;
      }

      const content: AssistantMessage["content"] =
        requestIndex === 1
          ? [{ type: "toolCall", id: "queued-action-call", name: tool.name, arguments: {} }]
          : [{ type: "text", text: "queued turn finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requestIndex === 1 ? "toolUse" : "stop"),
      );
    },
  );

  return { executeTool, requests, tool };
}

describe("AgentSession queue and next-turn lifecycle correctness", () => {
  it.each(["queued", "steering"] as const)(
    "preserves %s custom context envelopes across transcript replay",
    async (delivery) => {
      const { session, sessionManager } = await createTestSession();
      const timestamp = 1717570800000;
      const text = "Persistent synthetic context";
      const convert = session.agent.convertToLlm;
      session.agent.convertToLlm = (messages) =>
        convert(normalizeMessagesForLlmBoundary(messages, { appendOnlyRuntimeContext: true }));
      let requested: Context["messages"] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requested = structuredClone(context.messages);
        return textStream(model);
      });
      if (delivery === "queued") {
        session[agentSessionQueuePromptContext]({
          role: "custom",
          customType: "cache-context",
          content: text,
          display: false,
          timestamp,
        });
      } else {
        setSteeringRuntimeContextRetention(session, true);
        const user = { role: "user" as const, content: "Queued user", timestamp };
        const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
        try {
          attachSteeringRuntimeContext(user, { text });
        } finally {
          clock.mockRestore();
        }
        session.agent.steer(user);
      }
      await session.prompt("Continue");

      const replayed = await session.agent.convertToLlm(
        sessionManager.buildSessionContext().messages,
      );
      const contextMessage = (messages: Context["messages"]) =>
        messages.find((message) => JSON.stringify(message.content).includes(text));
      expect(contextMessage(requested)).toMatchObject({ role: "user", timestamp });
      expect(contextMessage(replayed)).toEqual(contextMessage(requested));
    },
  );

  it.each(
    (["apply", "dispose", "replace"] as const).flatMap((closure) =>
      (["preparation", "admission"] as const).map((phase) => ({ closure, phase })),
    ),
  )(
    "guards first-model $phase after a delayed SDK prompt override: $closure",
    async ({ closure, phase }) => {
      const hookEntered = createDeferredCore();
      const hookRelease = createDeferredCore();
      const preparationEntered = createDeferredCore();
      const preparationRelease = createDeferredCore();
      const handlers = handlersFor({
        before_agent_start: async () => {
          hookEntered.resolve();
          await hookRelease.promise;
          return { systemPrompt: "late SDK override" };
        },
      });
      const tools = ["read_policy", "write_policy"].map((name) =>
        makeTool(name, async () => ({ content: [], details: {} })),
      );
      const requests: Array<{ prompt: string; tools: string[] }> = [];
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        requests.push({
          prompt: context.systemPrompt ?? "",
          tools: context.tools?.map((tool) => tool.name) ?? [],
        });
        return textStream(model);
      });
      const { session } = await createTestSession({
        resourceLoader: createResourceLoader(handlers),
        customTools: tools,
      });
      const prompt = session.prompt("apply permissions before the first request");
      const settled = Promise.allSettled([prompt]);
      await hookEntered.promise;
      session[agentSessionSetPromptPreparation](async () => {
        const waitForUpdate = async () => {
          preparationEntered.resolve();
          await preparationRelease.promise;
        };
        const update = () => {
          session.setActiveToolsByName(["read_policy"]);
          session.agent.state.systemPrompt += "\nPermission change: read-only";
        };
        if (phase === "preparation") {
          await waitForUpdate();
          update();
          return undefined;
        }
        return async (onAdmitted) => {
          await waitForUpdate();
          onAdmitted(update);
          expect(session.agent.state.isStreaming).toBe(true);
        };
      });
      hookRelease.resolve();
      // A missing preparation boundary completes the request instead of entering the barrier.
      await Promise.race([settled, preparationEntered.promise]);
      try {
        expect(requests).toEqual([]);
        if (closure === "dispose") {
          session.dispose();
        } else if (closure === "replace") {
          session[agentSessionSetPromptPreparation](async () => {});
        }
      } finally {
        preparationRelease.resolve();
        await settled;
      }
      const [result] = await settled;
      if (closure === "apply") {
        expect(result?.status).toBe("fulfilled");
        expect(requests).toEqual([
          { prompt: "late SDK override\nPermission change: read-only", tools: ["read_policy"] },
        ]);
      } else {
        expect(result).toMatchObject({
          status: "rejected",
          reason: { message: "Session prompt preparation is stale after replacement or disposal." },
        });
        expect(requests).toEqual([]);
        if (phase === "admission") {
          expect(session.agent.state.systemPrompt).not.toContain("Permission change: read-only");
        }
      }
    },
  );

  it("drains a follow-up queued by an agent-end handler", async () => {
    const sessionRef: { current?: AgentSession } = {};
    let queued = false;
    const lifecycleEvents: string[] = [];
    const handlers = handlersFor({
      agent_end: async () => {
        lifecycleEvents.push("agent_end");
        if (!queued) {
          queued = true;
          await sessionRef.current?.followUp("queued after end");
        }
        return undefined;
      },
      agent_settled: async () => lifecycleEvents.push("agent_settled"),
    });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return textStream(activeModel, `answer ${requests.length}`);
    });
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
    sessionRef.current = session;

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("queued after end");
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(lifecycleEvents).toEqual(["agent_end", "agent_end", "agent_settled"]);
  });

  it("does not settle an active run when a concurrent prompt loses admission", async () => {
    const firstGate = createDeferredCore();
    const secondGate = createDeferredCore();
    let admissionCount = 0;
    const handlers = handlersFor({
      before_agent_start: async () =>
        await (admissionCount++ === 0 ? firstGate : secondGate).promise,
    });
    let finishResponse: (() => void) | undefined;
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      const response = heldResponse(activeModel);
      finishResponse = () => response.finish("finished");
      return response.stream;
    });
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
    const settled = vi.fn();
    session.subscribe((event) => {
      if (event.type === "agent_settled") {
        settled();
      }
    });

    const firstPrompt = session.prompt("first");
    await vi.waitFor(() => expect(admissionCount).toBe(1));
    const secondPrompt = session.prompt("second");
    await vi.waitFor(() => expect(admissionCount).toBe(2));
    firstGate.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    secondGate.resolve();

    await expect(secondPrompt).rejects.toThrow("Agent is already processing a prompt");
    expect(settled).not.toHaveBeenCalled();
    finishResponse?.();
    await firstPrompt;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("keeps one logical prompt owner across an automatic retry gap", async () => {
    vi.useFakeTimers();
    try {
      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        requests.push(context);
        if (requests.length === 1) {
          return createAssistantResultStream({
            ...createAssistant(activeModel, [], "error"),
            errorMessage: "HTTP 503 temporary provider response",
          });
        }
        return textStream(activeModel, "retry recovered");
      });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, baseDelayMs: 10_000, maxRetries: 1 },
      });
      const { session } = await createTestSession({ settingsManager });
      let permissionPrompt = "initial permission prompt";
      session[agentSessionSetPromptPreparation](async () => {
        session.agent.state.systemPrompt = permissionPrompt;
      });
      const lifecycleEvents: string[] = [];
      session.subscribe((event) => lifecycleEvents.push(event.type));

      const prompt = session.prompt("initial prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(1);
      expect(lifecycleEvents).toContain("auto_retry_start");

      permissionPrompt = "updated permission prompt";
      await session.prompt("steer during retry", { streamingBehavior: "steer" });
      expect(requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await prompt;

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.systemPrompt)).toEqual([
        "initial permission prompt",
        "updated permission prompt",
      ]);
      expect(JSON.stringify(requests[1]?.messages)).toContain("steer during retry");
      expect(lifecycleEvents.filter((type) => type === "agent_settled")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(imageQueues)(
    "retires an image-only $kind before terminal finalization",
    async (scenario) => {
      const { requests, finish } = mockHeldRun("image answer");
      const { session, sessionManager } = await createTestSession();
      const queueEvents: Array<{
        type: "queue_update" | "image_message_start";
        steering: readonly string[];
        followUp: readonly string[];
      }> = [];
      session.subscribe((event) => {
        if (event.type === "queue_update") {
          queueEvents.push({
            type: "queue_update",
            steering: event.steering,
            followUp: event.followUp,
          });
        } else if (
          event.type === "message_start" &&
          event.message.role === "user" &&
          Array.isArray(event.message.content) &&
          event.message.content.some((part) => part.type === "image")
        ) {
          queueEvents.push({
            type: "image_message_start",
            steering: [...session.getSteeringMessages()],
            followUp: [...session.getFollowUpMessages()],
          });
        }
      });
      const initialPrompt = session.prompt("describe the next image");
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      await scenario.queue(session);
      expect(session.pendingMessageCount).toBe(1);
      finish();
      await initialPrompt;

      expect(requests).toHaveLength(2);
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: [{ type: "text", text: "" }, image] }),
      );
      expect(sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "" }, image],
          }),
        }),
      );
      expect(session.pendingMessageCount).toBe(0);
      expect(session.getSteeringMessages()).toEqual([]);
      expect(session.getFollowUpMessages()).toEqual([]);
      expect(queueEvents).toEqual([
        { type: "queue_update", ...scenario.initialQueue },
        { type: "queue_update", steering: [], followUp: [] },
        { type: "image_message_start", steering: [], followUp: [] },
      ]);
    },
  );

  it("retires duplicate text by exact occurrence and owning queue once", async () => {
    const { session } = await createTestSession();
    await session.steer("same queued text");
    await session.steer("same queued text");
    await session.followUp("same queued text");
    const { queues, start } = queuedState(session);
    const [firstSteer, secondSteer] = queues.steeringQueue.messages;
    const [followUp] = queues.followUpQueue.messages;
    if (!firstSteer || !secondSteer || !followUp) {
      throw new Error("expected duplicate queued messages");
    }
    await start(secondSteer);
    await start(secondSteer);
    expect(session.getSteeringMessages()).toEqual(["same queued text"]);
    expect(session.getFollowUpMessages()).toEqual(["same queued text"]);
    expect(session.pendingMessageCount).toBe(2);

    await start(followUp);
    expect(session.getSteeringMessages()).toEqual(["same queued text"]);
    expect(session.getFollowUpMessages()).toEqual([]);
    expect(session.pendingMessageCount).toBe(1);

    await start(firstSteer);
    expect(session.pendingMessageCount).toBe(0);
  });

  it("keeps decorated queue ownership process-local and byte-invisible", async () => {
    const { session } = await createTestSession();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible transcript prompt" },
      target: createTestUserTurnTranscriptTarget(),
    });
    await session.steer(
      "runtime prompt",
      [image],
      recorder,
      [{ path: "/tmp/image.png", contentType: "image/png" }],
      undefined,
      "decorated-message",
    );
    const { queues, start } = queuedState(session);
    const [message] = queues.steeringQueue.messages;
    if (!message) {
      throw new Error("expected decorated queued message");
    }
    const serialized = JSON.stringify(message);
    const restored = JSON.parse(serialized) as QueuedMessage;
    await start(restored);
    expect(session.getSteeringMessages()).toEqual(["runtime prompt"]);
    expect(JSON.stringify(message)).toBe(serialized);

    await start(message);
    await start(message);

    expect(session.getSteeringMessages()).toEqual([]);
    expect(session.pendingMessageCount).toBe(0);
  });

  it.each([false, true])(
    "keeps accepted steering bytes stable across transcript persistence (image: %s)",
    async (withImage) => {
      const { session, sessionManager } = await createTestSession();
      const admittedAt = 1717570800000;
      const queuedAt = admittedAt + 120_000;
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "Visible transcript prompt",
          timestamp: admittedAt,
          sender: { id: "alice-id", name: "Alice" },
        },
        target: createTestUserTurnTranscriptTarget(),
      });
      const queued = vi.spyOn(session.agent, "admitSteeringMessage");
      const clock = vi.spyOn(Date, "now").mockReturnValue(queuedAt);
      try {
        await session.steer("Expanded runtime prompt", withImage ? [image] : undefined, recorder);
      } finally {
        clock.mockRestore();
      }
      const message = queued.mock.calls[0]?.[0];
      if (!message || message.role !== "user") {
        throw new Error("expected queued user message");
      }
      const registry = createUserTranscriptContextRegistry();
      const project = () =>
        normalizeMessagesForLlmBoundary([message], {
          timezone: "UTC",
          userTranscriptContexts: registry.list(),
        });
      const accepted = project();
      const guard = guardSessionManager(sessionManager, {
        onUserMessagePersisted: (persisted, runtime) => {
          if (runtime) {
            registry.record(runtime, persisted);
          }
        },
      });
      const entryId = guard.appendMessage(message);
      const acceptedContent = accepted[0]?.role === "user" ? accepted[0].content : undefined;
      const firstBlock = Array.isArray(acceptedContent) ? acceptedContent[0] : undefined;
      const acceptedText =
        typeof acceptedContent === "string"
          ? acceptedContent
          : firstBlock?.type === "text"
            ? firstBlock.text
            : undefined;

      expect(project()).toEqual(accepted);
      expect(acceptedText).toContain('"name":"Alice"');
      expect(acceptedText).toContain(
        buildTimestampPrefix(new Date(admittedAt), { timezone: "UTC" }),
      );
      expect(acceptedText).toContain("Expanded runtime prompt");
      expect(acceptedText).not.toContain("Visible transcript prompt");
      expect(message.timestamp).toBe(admittedAt);
      expect(message.content).toEqual([
        { type: "text", text: "Expanded runtime prompt" },
        ...(withImage ? [image] : []),
      ]);
      expect(guard.getEntry(entryId)).toMatchObject({
        message: {
          timestamp: admittedAt,
          content: withImage ? message.content : "Visible transcript prompt",
        },
      });
      if (withImage) {
        expect(acceptedContent).toContainEqual(image);
      }
    },
  );

  it.each(imageQueues)(
    "keeps queued image-only $kind dormant after its active run is aborted",
    async (scenario) => {
      const { executeTool, requests, tool } = mockAbortableQueuedRun();
      const { session } = await createTestSession({ customTools: [tool] });
      const prompt = session.prompt("wait for operator cancellation");
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      await scenario.queue(session);
      expect(session.agent.hasQueuedMessages()).toBe(true);

      await Promise.all([session.abort(), prompt]);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal?.aborted).toBe(true);
      expect(executeTool).not.toHaveBeenCalled();
      expect(session.agent.hasQueuedMessages()).toBe(true);
      expect(scenario.messages(session)).toEqual([""]);
    },
  );

  it.each([true, false])(
    "cancels only an uncommitted steer after an aborted turn (wait: %s)",
    async (waitForTranscriptCommit) => {
      const { executeTool, requests, tool } = mockAbortableQueuedRun();
      const { session } = await createTestSession({ customTools: [tool] });
      const prompt = session.prompt("wait for operator cancellation");
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      await session.steer("keep unrelated steering");
      await session.followUp("keep unrelated follow-up");
      const delivery = steerActiveSessionWithOptionalDeliveryWait(
        session,
        "cancel only this steering",
        { deliveryTimeoutMs: 10_000, waitForTranscriptCommit },
      ).then(
        () => (waitForTranscriptCommit ? "committed" : "admitted"),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await vi.waitFor(() =>
        expect(session.getSteeringMessages()).toEqual([
          "keep unrelated steering",
          "cancel only this steering",
        ]),
      );

      if (!waitForTranscriptCommit) {
        await expect(delivery).resolves.toBe("admitted");
      }
      await Promise.all([session.abort(), prompt]);

      await expect(delivery).resolves.toBe(
        waitForTranscriptCommit
          ? "active session ended before queued steering message was committed to the transcript"
          : "admitted",
      );
      expect(requests).toHaveLength(1);
      expect(executeTool).not.toHaveBeenCalled();
      expect(session.getSteeringMessages()).toEqual(["keep unrelated steering"]);
      expect(session.getFollowUpMessages()).toEqual(["keep unrelated follow-up"]);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      const nextRequests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        nextRequests.push(context);
        return textStream(model, "next answer");
      });
      await session.prompt("new legitimate turn");
      expect(nextRequests.length).toBeGreaterThan(0);
      expect(JSON.stringify(nextRequests)).not.toContain("cancel only this steering");
    },
  );

  it("cancels a steering confirmation after the runtime drains it", async () => {
    const { requests, finish } = mockHeldRun("stale steering ran");
    const { session } = await createTestSession();
    const turnRelease = createDeferredCore();
    const turnStarted = createDeferredCore();
    let turnStartCount = 0;
    session.agent.subscribe(async (event) => {
      if (event.type === "turn_start" && ++turnStartCount === 2) {
        turnStarted.resolve();
        await turnRelease.promise;
      }
    });
    const sourceAbort = new AbortController();
    const prompt = session.prompt("wait for steering");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const delivery = steerActiveSessionWithOptionalDeliveryWait(session, "cancel after drain", {
      abortSignal: sourceAbort.signal,
      deliveryTimeoutMs: 10_000,
      waitForTranscriptCommit: true,
    });
    const rejection = expect(delivery).rejects.toThrow(
      "queued steering message was cancelled before delivery",
    );
    await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual(["cancel after drain"]));

    finish();
    await turnStarted.promise;
    sourceAbort.abort();
    await rejection;
    turnRelease.resolve();
    await prompt;

    expect(requests).toHaveLength(1);
    expect(session.getSteeringMessages()).toEqual([]);
    expect(session.agent.hasQueuedMessages()).toBe(false);
  });

  it("applies session model, tool, and prompt changes on the following tool turn", async () => {
    const nextModel = { ...testModel, id: "next-model" };
    const sessionRef: { current?: AgentSession } = {};
    const switchTool = makeTool("switch_state", async () => {
      const activeSession = sessionRef.current;
      if (!activeSession) {
        throw new Error("session not ready");
      }
      activeSession.setActiveToolsByName(["second_tool"]);
      activeSession.agent.state.model = nextModel;
      return toolResult("switched");
    });
    const secondTool = makeTool("second_tool");
    const handlers = handlersFor({
      before_agent_start: async () => ({ systemPrompt: "prompt override" }),
    });
    const requests: Array<{ model: string; prompt: string; tools: string[] }> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push({
        model: activeModel.id,
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
      });
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [{ type: "toolCall", id: "call-switch", name: "switch_state", arguments: {} }]
          : [{ type: "text", text: "finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requests.length === 1 ? "toolUse" : "stop"),
      );
    });
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      customTools: [switchTool, secondTool],
    });
    sessionRef.current = session;
    session.setActiveToolsByName(["switch_state"]);

    await session.prompt("switch now");

    expect(requests).toEqual([
      { model: testModel.id, prompt: "prompt override", tools: ["switch_state"] },
      { model: nextModel.id, prompt: "prompt override", tools: ["second_tool"] },
    ]);
  });

  it("replaces permission-bound tools during a run without retaining removed tools", async () => {
    const executions: string[] = [];
    const sessionRef: { current?: AgentSession } = {};
    const readTool = makeTool("read_policy", async () => {
      executions.push("restricted");
      return toolResult("restricted");
    });
    const changeTool: ToolDefinition = {
      ...readTool,
      name: "change_permission",
      execute: async () => {
        sessionRef.current!.replaceCustomTools([readTool], [readTool.name]);
        return toolResult("Permission change");
      },
    };
    const previousReadTool: ToolDefinition = {
      ...readTool,
      execute: async () => {
        executions.push("unrestricted");
        return toolResult("unrestricted");
      },
    };
    const requests: string[][] = [];
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push(context.tools?.map((tool) => tool.name) ?? []);
      const name = requests.length === 1 ? changeTool.name : readTool.name;
      const content: AssistantMessage["content"] =
        requests.length < 3
          ? [{ type: "toolCall", id: `call-${requests.length}`, name, arguments: {} }]
          : [{ type: "text", text: "done" }];
      return createAssistantResultStream(
        createAssistant(model, content, requests.length < 3 ? "toolUse" : "stop"),
      );
    });
    const { session } = await createTestSession({ customTools: [changeTool, previousReadTool] });
    sessionRef.current = session;
    session.setActiveToolsByName([changeTool.name, readTool.name]);

    await session.prompt("tighten permissions");

    expect(requests).toEqual([[changeTool.name, readTool.name], [readTool.name], [readTool.name]]);
    expect(executions).toEqual(["restricted"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual([readTool.name]);
  });

  it("preserves explicit updates from an existing next-turn hook", async () => {
    const hookModel = { ...testModel, id: "hook-model" };
    const hookTool: AgentTool = {
      name: "hook_tool",
      label: "Hook tool",
      description: "provided by the existing turn hook",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const hookContext = {
      systemPrompt: "hook prompt",
      messages: [],
      tools: [hookTool],
    };
    let returnedUpdate = false;
    const { session } = await createTestSession();
    session.agent.prepareNextTurn = () => {
      if (returnedUpdate) {
        return undefined;
      }
      returnedUpdate = true;
      return { context: hookContext, model: hookModel, thinkingLevel: "high" };
    };
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const newMessages = [message];

    const firstUpdate = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [] },
      newMessages,
    });
    const secondUpdate = await contextualHook({
      message,
      toolResults: [],
      context: firstUpdate?.context ?? hookContext,
      newMessages,
    });

    for (const update of [firstUpdate, secondUpdate]) {
      expect(update).toMatchObject({
        context: {
          systemPrompt: "hook prompt",
          tools: [expect.objectContaining({ name: "hook_tool" })],
        },
        model: hookModel,
        thinkingLevel: "high",
      });
    }
  });

  it("preserves fields omitted by an existing next-turn context replacement", async () => {
    const sessionTool: AgentTool = {
      name: "session_tool",
      label: "Session tool",
      description: "available in session state",
      parameters: Type.Object({}),
      execute: async () => toolResult("done"),
    };
    const initialHook = vi.fn(() => ({
      context: { systemPrompt: "stale prompt", messages: [], tools: [sessionTool] },
    }));
    const replacementHook = vi.fn(() => ({
      context: { systemPrompt: "replacement prompt", messages: [] },
    }));
    const { session } = await createTestSession({ customTools: [sessionTool] });
    session.setActiveToolsByName([sessionTool.name]);
    session.agent.prepareNextTurn = initialHook;
    session.agent.prepareNextTurn = replacementHook;
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }

    const update = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [sessionTool] },
      newMessages: [message],
    });

    expect(update?.context).toEqual({ systemPrompt: "replacement prompt", messages: [] });
    expect(replacementHook).toHaveBeenCalledOnce();
    expect(initialHook).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when disposed", async () => {
    let providerSignal: AbortSignal | undefined;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        providerSignal = options?.signal;
        return heldResponse(activeModel, options?.signal).stream;
      },
    );
    const { session } = await createTestSession();
    const abortRetry = vi.spyOn(session, "abortRetry");
    const abortCompaction = vi.spyOn(session, "abortCompaction");
    const abortBranchSummary = vi.spyOn(session, "abortBranchSummary");
    const abortAgent = vi.spyOn(session.agent, "abort");
    abortRetry.mockImplementationOnce(() => {
      throw new Error("retry abort failed");
    });
    const prompt = session.prompt("wait");
    await vi.waitFor(() => expect(providerSignal).toBeDefined());

    session.dispose();
    await prompt;

    expect(providerSignal?.aborted).toBe(true);
    expect(abortRetry).toHaveBeenCalledOnce();
    expect(abortCompaction).toHaveBeenCalledOnce();
    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abortAgent).toHaveBeenCalledOnce();
  });

  it("resynchronizes queue modes when settings reload", async () => {
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({ settingsManager });
    settingsManager.setSteeringMode("all");
    settingsManager.setFollowUpMode("all");
    await settingsManager.flush();

    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("one-at-a-time");

    await session.reload();

    expect(session.agent.steeringMode).toBe("all");
    expect(session.agent.followUpMode).toBe("all");
  });
});
