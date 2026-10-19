import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { startQaMockOpenAiServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";
const QA_COMPACTION_SUMMARY_INSTRUCTIONS =
  "You are a context summarization assistant. Produce a structured summary. Do not continue.";

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer() {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => server.stop());
  return server;
}

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
  const server = await startServer();
  return { server, socket: await connectResponsesWebSocket(server.baseUrl) };
}

const userInput = (text: string) => [{ role: "user", content: [{ type: "input_text", text }] }];
const readTool = [{ type: "function", name: "read" }];
const streaming = { model: "gpt-5.6-sol", stream: true };
const debugJson = async (baseUrl: string, path: string) =>
  await fetch(`${baseUrl}/debug/${path}`).then((response) => response.json());

async function collectResponseEvents(socket: WebSocket, request: Record<string, unknown> | string) {
  return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
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
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      const event = JSON.parse(text) as Record<string, unknown>;
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

function readCompletedResponse(events: Array<Record<string, unknown>>) {
  const completion = events.find((event) => event.type === "response.completed");
  expect(completion).toBeDefined();
  return completion?.response as Record<string, unknown>;
}

function expectError(
  events: Array<Record<string, unknown>>,
  status: number,
  error: Record<string, unknown>,
  fields = {},
) {
  expect(events).toEqual([expect.objectContaining({ type: "error", status, error, ...fields })]);
}

function functionOutput(callId: unknown, output: string) {
  return [{ type: "function_call_output", call_id: callId, output }];
}

describe("QA mock OpenAI Responses WebSocket", () => {
  it("holds one continuation across a disconnect without holding its replacement", async () => {
    const server = await startServer();
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
    const { server, socket } = await startConnection();
    const prompt = "Read README.md for the source and docs discovery report.";
    const firstEvents = await collectResponseEvents(socket, {
      ...streaming,
      tools: readTool,
      input: userInput(prompt),
    });
    const firstResponse = readCompletedResponse(firstEvents);
    const output = firstResponse.output as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === "function_call");
    expect(toolCall?.call_id).toEqual(expect.any(String));

    const secondEvents = await collectResponseEvents(socket, {
      ...streaming,
      previous_response_id: firstResponse.id,
      input: functionOutput(toolCall?.call_id, "README: source and docs evidence captured"),
    });

    for (const events of [firstEvents, secondEvents]) {
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    }

    const requests = (await debugJson(server.baseUrl, "requests")) as Array<
      Record<string, unknown>
    >;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      prompt,
      toolOutput: "README: source and docs evidence captured",
      toolOutputCallId: toolCall?.call_id,
    });
  });

  it("preserves empty tool-result identity without replaying a native patch", async () => {
    const { server, socket } = await startConnection();
    const prompt =
      "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.";
    const initial = readCompletedResponse(
      await collectResponseEvents(socket, {
        tools: [{ type: "custom", name: "apply_patch" }],
        input: userInput(prompt),
      }),
    );
    const call = (initial.output as Array<Record<string, unknown>>)[0];
    expect(call).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });

    const completed = readCompletedResponse(
      await collectResponseEvents(socket, {
        previous_response_id: initial.id,
        input: [{ type: "custom_tool_call_output", call_id: call?.call_id, output: "" }],
      }),
    );

    expect(completed.output).toEqual([expect.objectContaining({ type: "message" })]);
    const debug = await debugJson(server.baseUrl, "last-request");
    expect(debug).toMatchObject({ toolOutput: "", toolOutputCallId: call?.call_id });
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  it("preserves the full warmup prompt when the first real response sends an empty delta", async () => {
    const { server, socket } = await startConnection();
    const prompt = "Read README.md for the source and docs discovery report.";

    const warmup = await collectResponseEvents(socket, {
      ...streaming,
      generate: false,
      tools: readTool,
      input: userInput(prompt),
    });

    const events = await collectResponseEvents(socket, {
      stream: true,
      previous_response_id: readCompletedResponse(warmup).id,
      input: [],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response.output_item.done" }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
    const lastRequest = await debugJson(server.baseUrl, "last-request");
    expect(lastRequest).toMatchObject({ model: "gpt-5.6-sol", prompt, plannedToolName: "read" });
    expect(await debugJson(server.baseUrl, "request-cursor")).toEqual({ cursor: 1 });
  });

  it("preserves the injected post-tool 503 failure on the WebSocket transport", async () => {
    const { server, socket } = await startConnection();
    const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";

    const firstEvents = await collectResponseEvents(socket, {
      ...streaming,
      tools: readTool,
      input: userInput(prompt),
    });
    const firstResponse = readCompletedResponse(firstEvents);
    const output = firstResponse.output as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === "function_call");

    const failure = await collectResponseEvents(socket, {
      ...streaming,
      previous_response_id: firstResponse.id,
      input: functionOutput(toolCall?.call_id, "QA mission loaded"),
    });

    expectError(failure, 503, { type: "server_error", message: "Service Unavailable" });
    expectError(
      await collectResponseEvents(socket, {
        previous_response_id: firstResponse.id,
        input: [],
      }),
      400,
      expect.objectContaining({ code: "previous_response_not_found" }),
      { sequence_number: 0 },
    );
    const requests = (await debugJson(server.baseUrl, "requests")) as Array<
      Record<string, unknown>
    >;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ prompt, toolOutput: "QA mission loaded" });
  });

  it("preserves the coded compaction overflow on the WebSocket transport", async () => {
    const { server, socket } = await startConnection();
    const failure = await collectResponseEvents(socket, {
      ...streaming,
      client_metadata: { session_id: "compaction-websocket" },
      input: userInput(`${QA_COMPACTION_RETRY_PROMPT}\n${"x".repeat(300_000)}`),
    });

    expectError(failure, 400, {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "This model's maximum context length was exceeded.",
    });
    const requests = await debugJson(server.baseUrl, "requests");
    expect(requests).toEqual([
      expect.objectContaining({
        requestKind: "agent-initial",
        outcome: "error",
        errorCode: "context_length_exceeded",
        rawByteLength: expect.any(Number),
      }),
    ]);
  });

  it.each([
    {
      faultMode: "empty-output-once",
      marker: "QA-COMPACTION-EMPTY-OUTPUT-ONCE-websocket",
      recoveredMarker: "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY",
    },
    {
      faultMode: "reasoning-only-output-once",
      marker: "QA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-websocket",
      recoveredMarker: "QA-COMPACTION-REASONING-RECOVERED-SUMMARY",
    },
  ] as const)("preserves $faultMode compaction recovery on WebSocket", async (testCase) => {
    const { server, socket } = await startConnection();
    const request = {
      ...streaming,
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: userInput(`<conversation>${testCase.marker}</conversation>`),
    };

    const first = readCompletedResponse(await collectResponseEvents(socket, request));
    expect(JSON.stringify(first.output)).not.toContain(testCase.recoveredMarker);
    const recovered = readCompletedResponse(await collectResponseEvents(socket, request));
    expect(JSON.stringify(recovered.output)).toContain(testCase.recoveredMarker);

    const requests = (await debugJson(server.baseUrl, "requests")) as Array<
      Record<string, unknown>
    >;
    expect(requests.map((entry) => entry.compactionSummaryFaultMode)).toEqual([
      testCase.faultMode,
      "none",
    ]);
  });

  it("returns a bounded protocol error for malformed WebSocket requests", async () => {
    const { socket } = await startConnection();

    const events = await collectResponseEvents(socket, "{invalid-json");

    expectError(events, 400, {
      type: "invalid_request_error",
      message: "Expected a JSON response.create request.",
    });
  });
});
