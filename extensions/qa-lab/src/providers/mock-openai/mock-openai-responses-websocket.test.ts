import { once } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { expect, it, describe } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createQaBusState } from "../../bus-state.js";
import { runScenarioFlow } from "../../scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "../../suite-runtime-flow.js";
import { makeQaSuiteTestScenario } from "../../suite-test-helpers.js";
import type { QaMockContinuationHold } from "../shared/types.js";
import { userInputs } from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  getJson,
  makeToolOutputWithCallId,
  outputItem,
  outputToolCall,
  postJson,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer, cleanups } = createMockServerTestHarness();

type JsonObject = Record<string, unknown>;

type Request = JsonObject | string;

const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";

async function connectResponsesWebSocket(baseUrl: string) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/u, "ws")}/v1/responses`);
  cleanups.push(async () => {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  });
  await once(socket, "open");
  return socket;
}

async function startConnection() {
  const server = await startMockServer();
  const socket = await connectResponsesWebSocket(server.baseUrl);
  const send = (request: Request) => collectResponseEvents(socket, request);
  return {
    send,
    read: (prompt: string, extra = {}) =>
      send({ ...streaming, tools: readTool, input: userInput(prompt), ...extra }),
    complete: async (request: Request) => readCompletedResponse(await send(request)),
    debug: (path: string) => debugJson(server.baseUrl, path),
  };
}

const userInput = (text: string) => [{ role: "user", content: [{ type: "input_text", text }] }];

const readTool = [{ type: "function", name: "read" }];

const streaming = { model: "gpt-5.6-sol", stream: true };

const debugJson = async (baseUrl: string, path: string) =>
  await fetch(`${baseUrl}/debug/${path}`).then((response) => response.json());

async function collectResponseEvents(socket: WebSocket, request: Request) {
  return await new Promise<JsonObject[]>((resolve, reject) => {
    const events: JsonObject[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the mock Responses WebSocket"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(rawDataToString(data)) as JsonObject;
      events.push(event);
      if (event.type === "response.completed" || event.type === "error") {
        cleanup();
        resolve(events);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(
      typeof request === "string"
        ? request
        : JSON.stringify({ type: "response.create", ...request }),
    );
  });
}

function readCompletedResponse(events: JsonObject[]) {
  const completion = events.find((event) => event.type === "response.completed");
  expect(completion).toBeDefined();
  return completion?.response as JsonObject;
}

function expectError(events: JsonObject[], status: number, error: JsonObject, fields = {}) {
  expect(events).toEqual([expect.objectContaining({ type: "error", status, error, ...fields })]);
}

function functionOutput(callId: unknown, output: string) {
  return [{ type: "function_call_output", call_id: callId, output }];
}

it("holds one continuation across a disconnect without holding its replacement", async () => {
  const server = await startMockServer();
  const controller = new AbortController();
  const hold = server.holdNextContinuation("replacement-session", controller.signal);
  const socket = await connectResponsesWebSocket(server.baseUrl);
  const request = {
    type: "response.create",
    client_metadata: { session_id: "replacement-session" },
    input: [
      { role: "user", content: "Reply exactly: REPLACED-OK" },
      { type: "function_call_output", call_id: "retained-call", output: "done" },
    ],
  };
  try {
    socket.send(JSON.stringify(request));
    expect(await hold.reached).toEqual({
      cursor: 1,
      sessionId: "replacement-session",
      toolOutputCallId: "retained-call",
    });
    const closed = once(socket, "close");
    socket.terminate();
    await closed;
    const replacement = await connectResponsesWebSocket(server.baseUrl);
    const response = readCompletedResponse(await collectResponseEvents(replacement, request));
    expect(response.output).toMatchObject([{ content: [{ text: "REPLACED-OK" }] }]);
    const recorded = await debugJson(server.baseUrl, "requests");
    expect(recorded).toMatchObject([
      { cursor: 1, sessionId: "replacement-session", toolOutputCallId: "retained-call" },
      { cursor: 2, sessionId: "replacement-session", toolOutputCallId: "retained-call" },
    ]);
  } finally {
    controller.abort();
  }
});

it("reconstructs Codex previous-response deltas on the same reusable connection", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Read README.md for the source and docs discovery report.";
  const firstEvents = await read(prompt);
  const firstResponse = readCompletedResponse(firstEvents);
  const output = firstResponse.output as JsonObject[];
  const toolCall = output.find((item) => item.type === "function_call");
  expect(toolCall?.call_id).toEqual(expect.any(String));
  const secondEvents = await send({
    ...streaming,
    previous_response_id: firstResponse.id,
    input: functionOutput(toolCall?.call_id, "README: source and docs evidence captured"),
  });
  for (const events of [firstEvents, secondEvents]) {
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  }
  const requests = (await debug("requests")) as JsonObject[];
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    prompt,
    toolOutput: "README: source and docs evidence captured",
    toolOutputCallId: toolCall?.call_id,
  });
});

it("preserves empty tool-result identity without replaying a native patch", async () => {
  const { complete, debug } = await startConnection();
  const prompt =
    "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.";
  const initial = await complete({
    tools: [{ type: "custom", name: "apply_patch" }],
    input: userInput(prompt),
  });
  const call = (initial.output as JsonObject[])[0];
  expect(call).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });
  const completed = await complete({
    previous_response_id: initial.id,
    input: [{ type: "custom_tool_call_output", call_id: call?.call_id, output: "" }],
  });
  expect(completed.output).toEqual([expect.objectContaining({ type: "message" })]);
  const recorded = await debug("last-request");
  expect(recorded).toMatchObject({ toolOutput: "", toolOutputCallId: call?.call_id });
  expect(recorded).not.toHaveProperty("plannedToolName");
});

it("preserves namespaced native custom-tool identity over Responses WebSocket", async () => {
  const { send } = await startConnection();
  const events = await send({
    tools: [
      {
        type: "namespace",
        name: "openclaw_direct",
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
          },
        ],
      },
    ],
    input: userInput(
      "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
    ),
  });
  for (const item of [
    ...["response.output_item.added", "response.output_item.done"].map((type) =>
      requireRecord(events.find((event) => event.type === type)?.item, type),
    ),
    outputItem(readCompletedResponse(events)),
  ]) {
    expect(item).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      namespace: "openclaw_direct",
    });
  }
});

it("preserves the full warmup prompt when the first real response sends an empty delta", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Read README.md for the source and docs discovery report.";
  const warmup = await read(prompt, { generate: false });
  const events = await send({
    stream: true,
    previous_response_id: readCompletedResponse(warmup).id,
    input: [],
  });
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["response.output_item.done", "response.completed"]),
  );
  expect(await debug("last-request")).toMatchObject({
    model: "gpt-5.6-sol",
    prompt,
    plannedToolName: "read",
  });
  expect(await debug("request-cursor")).toEqual({ cursor: 1 });
});

it("preserves the injected post-tool 503 failure on the WebSocket transport", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";
  const firstEvents = await read(prompt);
  const firstResponse = readCompletedResponse(firstEvents);
  const output = firstResponse.output as JsonObject[];
  const toolCall = output.find((item) => item.type === "function_call");
  const failure = await send({
    ...streaming,
    previous_response_id: firstResponse.id,
    input: functionOutput(toolCall?.call_id, "QA mission loaded"),
  });
  expectError(failure, 503, { type: "server_error", message: "Service Unavailable" });
  expectError(
    await send({ previous_response_id: firstResponse.id, input: [] }),
    400,
    expect.objectContaining({ code: "previous_response_not_found" }),
    { sequence_number: 0 },
  );
  const requests = (await debug("requests")) as JsonObject[];
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ prompt, toolOutput: "QA mission loaded" });
});

it("preserves the coded compaction overflow on the WebSocket transport", async () => {
  const { send, debug } = await startConnection();
  const failure = await send({
    ...streaming,
    client_metadata: { session_id: "compaction-websocket" },
    input: userInput(`${QA_COMPACTION_RETRY_PROMPT}\n${"x".repeat(300_000)}`),
  });
  expectError(failure, 400, {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "This model's maximum context length was exceeded.",
  });
  const requests = await debug("requests");
  expect(requests).toEqual([
    expect.objectContaining({
      requestKind: "agent-initial",
      outcome: "error",
      errorCode: "context_length_exceeded",
      rawByteLength: expect.any(Number),
    }),
  ]);
});

it("returns a bounded protocol error for malformed WebSocket requests", async () => {
  const { send } = await startConnection();
  expectError(await send("{invalid-json"), 400, {
    type: "invalid_request_error",
    message: "Expected a JSON response.create request.",
  });
});

describe("QA held continuation", () => {
  it("lets a maintained flow hold one exact session continuation before its response", async () => {
    const server = await startMockServer();
    const controller = new AbortController();
    const sessionId = "held-session";
    const input = userInputs("Inspect the repo kickoff task.");
    const post = (items: unknown[], id = sessionId) =>
      postJson(server, "/v1/responses", { input: items }, { session_id: id });
    const initial = await post(input);
    const call = outputToolCall(await initial.json(), "read");
    if (typeof call.call_id !== "string") {
      throw new Error("provider omitted tool-call identity");
    }
    const vars: Record<string, QaMockContinuationHold> = {};
    try {
      const result = await runScenarioFlow({
        api: {
          env: { mock: server },
          signal: controller.signal,
          state: createQaBusState(),
          scenario: makeQaSuiteTestScenario("held-continuation"),
          config: {},
          runScenario: runQaSuiteScenarioSteps,
        },
        scenarioTitle: "held continuation",
        vars,
        flow: {
          steps: [
            {
              name: "arm",
              actions: [
                {
                  call: "env.mock.holdNextContinuation",
                  args: [sessionId, { expr: "signal" }],
                  saveAs: "hold",
                },
              ],
            },
          ],
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "pass",
        steps: [{ status: "pass" }],
      });
      const hold = vars.hold;
      if (!hold) {
        throw new Error("scenario did not return its continuation hold");
      }
      const continuation = [...input, call, makeToolOutputWithCallId(call.call_id, "done")];
      // An initial request and another session's continuation must not consume the hold.
      expect((await post(userInputs("Reply exactly: INITIAL-OK"))).status).toBe(200);
      expect((await post(continuation, "other-session")).status).toBe(200);
      const summary = await postJson(server, "/v1/responses", {
        client_metadata: { session_id: sessionId },
        instructions:
          "You are a context summarization assistant. Produce a structured summary. Do not continue.",
        input: continuation,
      });
      expect(summary.status).toBe(200);
      let completed = false;
      const pending = post(continuation).then((response) => {
        completed = true;
        return response;
      });
      const checkpoint = await Promise.race([
        hold.reached,
        pending.then(() => {
          throw new Error("continuation responded before checkpoint");
        }),
      ]);
      expect(checkpoint).toEqual({ cursor: 5, sessionId, toolOutputCallId: call.call_id });
      expect(await getJson(server, "/debug/requests?after=4")).toMatchObject([
        { ...checkpoint, requestKind: "tool-continuation", toolOutput: "done" },
      ]);
      expect(completed).toBe(false);
      hold.release();
      expect((await pending).status).toBe(200);
      // The hold is one-shot; observing the same identity again proceeds naturally.
      expect((await post(continuation)).status).toBe(200);
    } finally {
      controller.abort();
    }
  });

  it("cancels an unreached hold without poisoning the next scenario", async () => {
    const server = await startMockServer();
    const controller = new AbortController();
    const first = server.holdNextContinuation("first-session", controller.signal);
    expect(() => first.release()).toThrow("has not reached");
    expect(() => server.holdNextContinuation("other-session", controller.signal)).toThrow(
      "idle hold",
    );
    controller.abort();
    await expect(first.reached).rejects.toThrow("hold aborted");
    const next = server.holdNextContinuation("next-session", new AbortController().signal);
    first.cancel();
    // A stale handle must not cancel the replacement hold; provider shutdown must.
    await cleanups.pop()?.();
    await expect(next.reached).rejects.toThrow("provider stopped");
    expect(() => server.holdNextContinuation("late-session", new AbortController().signal)).toThrow(
      "live provider",
    );
  });

  it.each(["cancel", "abort", "stop"] as const)(
    "settles a held HTTP dispatch on %s",
    async (action) => {
      const server = await startMockServer();
      const controller = new AbortController();
      const hold = server.holdNextContinuation("cleanup-session", controller.signal);
      const pending = postJson(server, "/v1/responses", {
        client_metadata: { session_id: "cleanup-session" },
        input: userInputs("Reply exactly: DONE", makeToolOutputWithCallId("cleanup-call", "done")),
      });
      await hold.reached;
      if (action === "cancel") {
        hold.cancel();
      } else if (action === "abort") {
        controller.abort();
      } else {
        await cleanups.pop()?.();
      }
      const response = await pending;
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("QA continuation");
    },
  );
});
