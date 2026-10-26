import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
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
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "./agent-session-prompting.js";
import type { AgentSession } from "./agent-session.js";
import type { ExtensionFactory, ToolDefinition } from "./extensions/types.js";
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
  execute: AgentTool["execute"] = async () => toolResult("done"),
): AgentTool => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute,
});
const textStream = (model: Model, text = "done") =>
  createAssistantResultStream(createAssistant(model, text));
const toolStream = (model: Model, name: string, id = "call") =>
  createAssistantResultStream(
    createAssistant(model, [{ type: "toolCall", id, name, arguments: {} }], "toolUse"),
  );

function recordRequests(
  respond: (model: Model, index: number) => ReturnType<typeof textStream> = (model) =>
    textStream(model),
) {
  const requests: Array<{ model: string; prompt: string; tools: string[]; context: Context }> = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests.push({
      model: model.id,
      prompt: context.systemPrompt ?? "",
      tools: context.tools?.map((tool) => tool.name) ?? [],
      context,
    });
    return respond(model, requests.length);
  });
  return requests;
}

type NextTurnContext = Parameters<
  NonNullable<AgentSession["agent"]["prepareNextTurnWithContext"]>
>[0]["context"];

function nextTurnPreparer(session: AgentSession) {
  const hook = session.agent.prepareNextTurnWithContext;
  if (!hook) {
    throw new Error("context-aware next-turn hook was not installed");
  }
  const message = createAssistant(testModel, "turn complete");
  const newMessages = [message];
  return (context: NextTurnContext) => hook({ message, toolResults: [], context, newMessages });
}

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
        message: createAssistant(model, text),
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

async function startAbortableQueuedRun() {
  const executeTool = vi.fn(async () => toolResult("action completed"));
  const requests: Array<{ context: Context; signal: AbortSignal | undefined }> = [];
  const tool = makeTool("queued_action", executeTool);

  streamMocks.streamSimple.mockImplementation(
    (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
      const requestIndex = requests.length;
      requests.push({ context, signal: options?.signal });
      if (requestIndex === 0) {
        return heldResponse(activeModel, options?.signal).stream;
      }

      return requestIndex === 1
        ? toolStream(activeModel, tool.name, "queued-action-call")
        : textStream(activeModel, "queued turn finished");
    },
  );

  const { session } = await createTestSession({ customTools: [tool] });
  const prompt = session.prompt("wait for operator cancellation");
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  return { executeTool, requests, session, prompt };
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
      const handlers: ExtensionFactory = (api) => {
        api.on("before_agent_start", async () => {
          hookEntered.resolve();
          await hookRelease.promise;
          return { systemPrompt: "late SDK override" };
        });
      };
      const tools = ["read_policy", "write_policy"].map((name) =>
        makeTool(name, async () => ({ content: [], details: {} })),
      );
      const requests = recordRequests();
      const { session } = await createTestSession({
        extension: handlers,
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
        expect(
          requests.map((request) => ({ prompt: request.prompt, tools: request.tools })),
        ).toEqual([
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
    let queued = false;
    const lifecycleEvents: string[] = [];
    const handlers: ExtensionFactory = (api) => {
      api.on("agent_end", async () => {
        lifecycleEvents.push("agent_end");
        if (!queued) {
          queued = true;
          await session.followUp("queued after end");
        }
        return undefined;
      });
      api.on("agent_settled", async () => {
        lifecycleEvents.push("agent_settled");
      });
    };
    const requests = recordRequests((model, index) => textStream(model, `answer ${index}`));
    const { session } = await createTestSession({ extension: handlers });

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.context.messages)).toContain("queued after end");
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(lifecycleEvents).toEqual(["agent_end", "agent_end", "agent_settled"]);
  });

  it("does not settle an active run when a concurrent prompt loses admission", async () => {
    const firstGate = createDeferredCore();
    const secondGate = createDeferredCore();
    let admissionCount = 0;
    const handlers: ExtensionFactory = (api) => {
      api.on(
        "before_agent_start",
        async () => await (admissionCount++ === 0 ? firstGate : secondGate).promise,
      );
    };
    let finishResponse: (() => void) | undefined;
    const requests = recordRequests((model) => {
      const response = heldResponse(model);
      finishResponse = () => response.finish("finished");
      return response.stream;
    });
    const { session } = await createTestSession({ extension: handlers });
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
      const requests = recordRequests((model, index) => {
        if (index === 1) {
          return createAssistantResultStream({
            ...createAssistant(model, [], "error"),
            errorMessage: "HTTP 503 temporary provider response",
          });
        }
        return textStream(model, "retry recovered");
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
      expect(requests.map((request) => request.prompt)).toEqual([
        "initial permission prompt",
        "updated permission prompt",
      ]);
      expect(JSON.stringify(requests[1]?.context.messages)).toContain("steer during retry");
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
      const recordQueue = (type: "queue_update" | "image_message_start") => {
        queueEvents.push({
          type,
          steering: [...session.getSteeringMessages()],
          followUp: [...session.getFollowUpMessages()],
        });
      };
      session.subscribe((event) => {
        if (event.type === "queue_update") {
          recordQueue("queue_update");
        } else if (
          event.type === "message_start" &&
          event.message.role === "user" &&
          Array.isArray(event.message.content) &&
          event.message.content.some((part) => part.type === "image")
        ) {
          recordQueue("image_message_start");
        }
      });
      const initialPrompt = session.prompt("describe the next image");
      await vi.waitFor(() => expect(requests).toHaveLength(1));

      await scenario.queue(session);
      expect(session.pendingMessageCount).toBe(1);
      finish();
      await initialPrompt;

      expect(requests).toHaveLength(2);
      const queuedImage = expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "" }, image],
      });
      expect(requests[1]?.messages).toContainEqual(queuedImage);
      expect(sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({ type: "message", message: queuedImage }),
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
      const accepted = JSON.stringify(message);
      const guard = guardSessionManager(sessionManager);
      const entryId = guard.appendMessage(message);
      expect(JSON.stringify(message)).toBe(accepted);
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
    },
  );

  it.each(imageQueues)(
    "keeps queued image-only $kind dormant after its active run is aborted",
    async (scenario) => {
      const { executeTool, requests, session, prompt } = await startAbortableQueuedRun();

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
      const { executeTool, requests, session, prompt } = await startAbortableQueuedRun();

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
      const nextRequests = recordRequests((model) => textStream(model, "next answer"));
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
    const switchTool = makeTool("switch_state", async () => {
      session.setActiveToolsByName(["second_tool"]);
      session.agent.state.model = nextModel;
      return toolResult("switched");
    });
    const secondTool = makeTool("second_tool");
    const handlers: ExtensionFactory = (api) => {
      api.on("before_agent_start", async () => ({ systemPrompt: "prompt override" }));
    };
    const requests = recordRequests((model, index) =>
      index === 1
        ? toolStream(model, "switch_state", "call-switch")
        : textStream(model, "finished"),
    );
    const { session } = await createTestSession({
      extension: handlers,
      customTools: [switchTool, secondTool],
    });
    session.setActiveToolsByName(["switch_state"]);

    await session.prompt("switch now");

    expect(requests.map(({ model, prompt, tools }) => ({ model, prompt, tools }))).toEqual([
      { model: testModel.id, prompt: "prompt override", tools: ["switch_state"] },
      { model: nextModel.id, prompt: "prompt override", tools: ["second_tool"] },
    ]);
  });

  it("replaces permission-bound tools during a run without retaining removed tools", async () => {
    const executions: string[] = [];
    const readTool = makeTool("read_policy", async () => {
      executions.push("restricted");
      return toolResult("restricted");
    });
    const changeTool: ToolDefinition = {
      ...readTool,
      name: "change_permission",
      execute: async () => {
        session.replaceCustomTools([readTool], [readTool.name]);
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
    const requests = recordRequests((model, index) =>
      index < 3
        ? toolStream(model, index === 1 ? changeTool.name : readTool.name, `call-${index}`)
        : textStream(model),
    );
    const { session } = await createTestSession({ customTools: [changeTool, previousReadTool] });
    session.setActiveToolsByName([changeTool.name, readTool.name]);

    await session.prompt("tighten permissions");

    expect(requests.map(({ tools }) => tools)).toEqual([
      [changeTool.name, readTool.name],
      [readTool.name],
      [readTool.name],
    ]);
    expect(executions).toEqual(["restricted"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual([readTool.name]);
  });

  it.each(["explicit", "omitted"] as const)(
    "preserves %s next-turn hook fields",
    async (fields) => {
      const hookTool = makeTool("hook_tool");
      const hookModel = { ...testModel, id: "hook-model" };
      const context: NextTurnContext = {
        systemPrompt: "hook prompt",
        messages: [],
        ...(fields === "explicit" ? { tools: [hookTool] } : {}),
      };
      const tools = fields === "explicit" ? [] : [hookTool];
      const { session } = await createTestSession({ customTools: tools });
      const snapshot = {
        context,
        ...(fields === "explicit" ? { model: hookModel, thinkingLevel: "high" as const } : {}),
      };
      const hook = vi
        .fn<NonNullable<AgentSession["agent"]["prepareNextTurn"]>>()
        .mockReturnValueOnce(snapshot);
      session.agent.prepareNextTurn = hook;
      const prepareNextTurn = nextTurnPreparer(session);
      const update = await prepareNextTurn({
        systemPrompt: "loop prompt",
        messages: [],
        tools,
      });
      expect(update?.context).toEqual(context);
      expect(hook).toHaveBeenCalledOnce();
      if (fields === "explicit") {
        expect(update).toMatchObject(snapshot);
        expect(await prepareNextTurn(update?.context ?? context)).toMatchObject(snapshot);
      }
    },
  );

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

    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("one-at-a-time");

    await session.reload();

    expect(session.agent.steeringMode).toBe("all");
    expect(session.agent.followUpMode).toBe("all");
  });
});
