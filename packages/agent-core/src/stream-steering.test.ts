import { setImmediate } from "node:timers/promises";
import type { AssistantMessage, Message, StreamOptions, UserMessage } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  makeAssistantMessage,
  makeCall,
  makeTool,
  model as baseModel,
} from "./agent-loop.test-support.js";
import { Agent, type AgentOptions } from "./agent.js";
import { createAssistantMessageEventStream } from "./llm.js";
import type { AgentTool, StreamFn } from "./types.js";

const model = { ...baseModel, id: "steerable-model", name: "Steerable model", reasoning: true };

function assistant(text: string): AssistantMessage {
  return { ...makeAssistantMessage([{ type: "text", text }]), model: model.id, timestamp: 2 };
}

async function activeResponse(
  options: Pick<AgentOptions, "steeringMode" | "convertToLlm" | "transformContext"> & {
    steer?: (messages: readonly UserMessage[]) => Promise<boolean>;
    tools?: AgentTool[];
    needsContinuation?: () => boolean;
  } = {},
) {
  const { needsContinuation } = options;
  const started = createDeferred();
  const submitted = createDeferred();
  const steer = vi.fn(async (messages: readonly UserMessage[]) => {
    submitted.resolve();
    return options.steer ? options.steer(messages) : true;
  });
  const requests: Message[][] = [];
  const firstResponse = createAssistantMessageEventStream();
  let disconnect: ReturnType<NonNullable<StreamOptions["onActiveResponse"]>>;
  const streamFn: StreamFn = (_model, context, streamOptions) => {
    requests.push([...context.messages]);
    if (requests.length === 1) {
      disconnect = streamOptions?.onActiveResponse?.({ steer, needsContinuation });
      firstResponse.push({ type: "start", partial: assistant("") });
      started.resolve();
      return firstResponse;
    }
    const response = createAssistantMessageEventStream();
    response.push({ type: "done", reason: "stop", message: assistant("updated answer") });
    response.end();
    return response;
  };
  const agent = new Agent({ initialState: { model, tools: options.tools }, streamFn, ...options });
  const run = agent.prompt("original question");
  await started.promise;
  return {
    run,
    steer,
    submitted: submitted.promise,
    agent,
    requests,
    firstResponse,
    finish: (message = assistant("original answer")) => {
      disconnect?.();
      firstResponse.push({ type: "done", reason: "stop", message });
      firstResponse.end();
    },
    fail: () => {
      disconnect?.();
      firstResponse.push({
        type: "error",
        reason: "error",
        error: { ...assistant(""), stopReason: "error", errorMessage: "provider failed" },
      });
      firstResponse.end();
    },
  };
}

it.each(["one-at-a-time", "all"] as const)(
  "projects context and finishes an accepted batch before later %s updates",
  async (steeringMode) => {
    const { agent, steer, finish, run, requests } = await activeResponse({
      steeringMode,
      transformContext: async (messages) => {
        let userTurn = 0;
        return messages.map((message) =>
          message.role === "user"
            ? { ...message, content: `Turn ${++userTurn}: ${JSON.stringify(message.content)}` }
            : message,
        );
      },
    });

    const firstUpdate = { role: "user" as const, content: "first update", timestamp: 3 };
    agent.steer(firstUpdate);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    agent.steer({ role: "user", content: "second update", timestamp: 4 });
    await setImmediate();
    finish();
    await run;
    expect(steer).toHaveBeenCalledExactlyOnceWith([requests[1]?.at(-1)]);
    expect(requests[1]?.at(-1)).toMatchObject({ role: "user", content: 'Turn 2: "first update"' });
    expect(requests[2]?.at(-1)).toMatchObject({ content: 'Turn 3: "second update"' });
    expect(agent.state.messages).toContain(firstUpdate);
  },
);

it.each([false, true])(
  "queues incompatible context after accepted input=%s",
  async (acceptedInput) => {
    const update: UserMessage = { role: "user", content: "change direction", timestamp: 3 };
    const { agent, steer, finish, run, requests } = await activeResponse({
      steeringMode: "all",
      transformContext: async (messages) =>
        messages.includes(update) ? messages.filter((message) => message === update) : messages,
    });

    const earlier: UserMessage = { role: "user", content: "accepted update", timestamp: 2 };
    if (acceptedInput) {
      agent.steer(earlier);
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    }
    agent.steer(update);
    await setImmediate();
    finish();
    await run;
    expect(steer).toHaveBeenCalledTimes(acceptedInput ? 1 : 0);
    expect(requests[1]?.at(-1)).toBe(acceptedInput ? earlier : update);
    expect(requests[acceptedInput ? 2 : 1]).toEqual([update]);
  },
);

it.each(["abort", "error"] as const)(
  "releases admitted input for cancellation after the run ends with %s",
  async (terminal) => {
    const { agent, submitted, finish, fail, run } = await activeResponse({});

    const update: UserMessage = { role: "user", content: "recoverable update", timestamp: 3 };
    agent.steer(update);
    await submitted;
    expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
    if (terminal === "abort") {
      agent.abort();
      finish();
    } else {
      fail();
    }
    await run;
    expect(agent.state.messages).not.toContain(update);
    expect(agent.hasQueuedMessages()).toBe(true);
    expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
    expect(agent.hasQueuedMessages()).toBe(false);
  },
);
it("continues after an automatic response when transport still owns deferred tool input", async () => {
  let deferredInput = false;
  const needsContinuation = vi.fn(() => deferredInput);
  const { finish, run, requests, agent } = await activeResponse({ needsContinuation });

  deferredInput = true;
  finish();
  await run;
  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toMatchObject({ role: "assistant" });
  expect(needsContinuation).toHaveBeenCalledOnce();
  expect(agent.state.messages.at(-1)).toMatchObject({
    content: [{ type: "text", text: "updated answer" }],
  });
});
it.each(["one-at-a-time", "all"] as const)(
  "keeps a drained %s steering batch ahead of later input while an async call settles",
  async (steeringMode) => {
    const settled = createDeferred();

    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent, submitted, firstResponse, steer, finish, run, requests } = await activeResponse({
      steeringMode,
      tools: [{ ...makeTool("lookup"), parameters: Type.Object({}), execute }],
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        settled.resolve();
      }
    });

    const first: UserMessage = { role: "user", content: "first update", timestamp: 3 };
    const second: UserMessage = { role: "user", content: "second update", timestamp: 4 };
    agent.steer(first);
    await submitted;
    const toolCall = { ...makeCall("lookup", "call_1"), async: true as const };
    const partial = { ...assistant(""), content: [toolCall] };
    firstResponse.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    await settled.promise;
    agent.steer(second);
    await setImmediate();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledOnce();
    finish({
      ...assistant("original answer"),
      content: [toolCall, { type: "text", text: "original answer" }],
    });
    await run;
    expect(requests[1]?.at(-1)).toBe(first);
    expect(requests[2]?.at(-1)).toBe(second);
  },
);
it("sends queued input before generation ends and commits it once at the normal boundary", async () => {
  const { agent, submitted, steer, finish, run, requests } = await activeResponse({});

  const update: UserMessage = { role: "user", content: "change direction", timestamp: 3 };
  const later: UserMessage = { role: "user", content: "later update", timestamp: 4 };
  agent.steer(update);
  await submitted;
  expect(steer).toHaveBeenCalledWith([update]);
  expect(agent.state.messages).not.toContain(update);

  agent.steer(later);
  await setImmediate();
  expect(steer).toHaveBeenCalledTimes(1);
  expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
  agent.clearSteeringQueue();
  finish();
  await run;

  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toBe(update);
  expect(agent.state.messages.filter((message) => message === update)).toHaveLength(1);
  expect(agent.state.messages).not.toContain(later);
  expect(agent.hasQueuedMessages()).toBe(false);
  agent.steer({ role: "user", content: "next run", timestamp: 5 });
  expect(steer).toHaveBeenCalledTimes(1);
});

it("allows cancellation after definite rejection but fences cancellation during admission", async () => {
  const decision = createDeferred<boolean>();

  const { agent, submitted, steer, finish, run, requests } = await activeResponse({
    steer: async () => decision.promise,
    steeringMode: "all",
  });

  const update: UserMessage = { role: "user", content: "optional update", timestamp: 3 };
  agent.steer(update);
  await submitted;
  expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
  decision.resolve(false);
  await setImmediate();
  const later: UserMessage = { role: "user", content: "later update", timestamp: 4 };
  agent.steer(later);
  await setImmediate();
  expect(steer).toHaveBeenCalledTimes(1);
  expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
  finish();
  await run;
  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toBe(later);
  expect(agent.state.messages).not.toContain(update);
});

it("does not submit input after abort wins an awaited conversion", async () => {
  const converting = createDeferred();
  const converted = createDeferred<Message[]>();

  const update: UserMessage = { role: "user", content: "late update", timestamp: 3 };
  const { agent, requests, finish, run, steer } = await activeResponse({
    convertToLlm: (messages) => {
      if (messages.includes(update)) {
        converting.resolve();
        return converted.promise;
      }
      return messages as Message[];
    },
  });

  agent.steer(update);
  await converting.promise;
  agent.abort();
  converted.resolve([...requests.flat(), update]);
  finish();
  await run;
  expect(steer).not.toHaveBeenCalled();
  expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
});
