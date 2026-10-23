import { getTextContent, type ChatCompletionRequest } from "@copilotkit/aimock";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startQaAimockServer } from "./server.js";

function makeResponsesInput(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "input_text" as const, text }],
  };
}

describe("qa aimock server", () => {
  let server: Awaited<ReturnType<typeof startQaAimockServer>>;
  beforeEach(async () => {
    server = await startQaAimockServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function json(path: string, body?: unknown, expectedStatus = 200) {
    const init =
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    const response = await fetch(`${server.baseUrl}${path}`, init);
    expect(response.status).toBe(expectedStatus);
    return response.json();
  }

  const post = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    json("/v1/chat/completions", {
      model: "aimock/gpt-5.6-luna",
      stream: false,
      messages,
      ...extra,
    });

  it("matches programmatic fixtures across trailing runtime context without rewriting requests", async () => {
    const client = new OpenAI({
      baseURL: `${server.baseUrl}/v1`,
      apiKey: "qa-local",
      maxRetries: 0,
    });
    const userText = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "Task context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      "Recover the research answer",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "Begin the task.",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n\n");
    const toolOutput = "approval-unavailable: initiating-platform-disabled";
    const carrier = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "Synthetic runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    const call = {
      type: "function_call" as const,
      call_id: "call_shell",
      name: "exec",
      arguments: "{}",
    };
    const request = (text: string, output: string) =>
      client.responses.create({
        model: "gpt-5.6-luna",
        input: [
          makeResponsesInput(text),
          call,
          { type: "function_call_output", call_id: call.call_id, output },
          makeResponsesInput(carrier),
        ],
      });
    const reset = await fetch(`${server.baseUrl}/__aimock/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    await reset.json();
    server.addFixture({
      match: {
        predicate: (body) => {
          const tool = body.messages.findLast((message) => message.role === "tool");
          return (
            body.messages.some(
              (message) => message.role === "user" && getTextContent(message.content) === userText,
            ) &&
            tool?.tool_call_id === call.call_id &&
            getTextContent(tool.content) === toolOutput
          );
        },
      },
      response: {
        toolCalls: [{ id: "call_read", name: "read", arguments: '{"path":"note.md"}' }],
      },
    });
    for (const { text, output } of [
      { text: "unrelated request", output: toolOutput },
      { text: userText, output: "approval-pending" },
    ]) {
      await expect(request(text, output)).rejects.toMatchObject({
        status: 404,
        code: "no_fixture_match",
      });
    }
    const response = await request(userText, toolOutput);
    expect(response.output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_read",
        name: "read",
        arguments: '{"path":"note.md"}',
      }),
    );
    const debug = await json(`/debug/last-request`);
    const expectedMessages: ChatCompletionRequest["messages"] = [
      { role: "user", content: userText },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: call.call_id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      },
      { role: "tool", content: toolOutput, tool_call_id: call.call_id },
      { role: "user", content: carrier },
    ];
    expect(debug.body.messages).toEqual(expectedMessages);
    expect(JSON.parse(debug.raw)).toEqual(debug.body);
    expect(debug).toMatchObject({
      prompt: userText,
      toolOutput,
      toolOutputCallId: call.call_id,
      plannedToolCallId: "call_read",
    });
    const journal = await json(`/__aimock/journal`);
    expect(journal.at(-1).body).toEqual(debug.body);

    const registered = await json(`/__aimock/fixtures`, {
      fixtures: [
        {
          match: { userMessage: "ordinary HTTP fixture" },
          response: { content: "HTTP_MATCH_OK" },
        },
      ],
    });
    expect(registered).toEqual({ added: 1 });
    const httpResponse = await client.responses.create({
      model: "gpt-5.6-luna",
      input: "prefix ordinary HTTP fixture suffix",
    });
    expect(httpResponse.output_text).toBe("HTTP_MATCH_OK");
  });

  it("keeps non-chat image journal entries out of chat debug state", async () => {
    const prompt = "chat request remains the latest chat snapshot";
    await post([{ role: "user", content: prompt }]);
    await json("/v1/images/generations", { model: "dall-e-3" }, 400);

    expect(await json(`/debug/image-generations`)).toEqual([{}]);
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: 1 });
    expect(await json(`/debug/requests`)).toEqual([expect.objectContaining({ prompt })]);
    expect(await json(`/debug/last-request`)).toMatchObject({ prompt });
  });

  it.each(["chat", "responses"])(
    "retains exact %s request facts when tool schemas exceed the upstream journal cap",
    async (dialect) => {
      const model = "aimock/gpt-5.6-luna";
      const prompt = "current user marker";
      const tool = { name: "echo", description: "schema".repeat(14_000), parameters: {} };
      await json(`/v1/${dialect === "chat" ? "chat/completions" : "responses"}`, {
        model,
        stream: false,
        ...(dialect === "chat"
          ? {
              messages: [
                { role: "user", content: prompt },
                { role: "tool", content: "observed tool output", tool_call_id: "call-qa" },
              ],
              tools: [{ type: "function", function: tool }],
            }
          : {
              input: [
                makeResponsesInput(prompt),
                {
                  type: "function_call_output",
                  output: "observed tool output",
                  call_id: "call-qa",
                },
              ],
              tools: [{ type: "function", ...tool }],
            }),
      });
      const snapshot = await json(`/debug/last-request`);
      expect(snapshot).toMatchObject({
        model,
        prompt,
        allInputText: `${prompt}\nobserved tool output`,
        toolOutput: "observed tool output",
        toolOutputCallId: "call-qa",
        providerVariant: "openai",
        body: { __aimock_truncated: true },
      });
      expect(JSON.parse(snapshot.raw)).toEqual(snapshot.body);
      expect(snapshot.body.originalByteSize).toBeGreaterThan(64 * 1024);
    },
  );

  it.each([
    { role: "system", content: "s".repeat(70_000), omittedFields: ["allInputText"] },
    { role: "user", content: "😀".repeat(20_000), omittedFields: ["prompt", "allInputText"] },
  ])("reports incomplete $role text without poisoning later queries or metadata", async (input) => {
    await post([
      ...(input.role === "system" ? [{ role: "user", content: "exact current user" }] : []),
      { role: input.role, content: input.content },
    ]);
    for (const endpoint of ["last-request", "requests", "requests?after=0"]) {
      const incomplete = await json(`/debug/${endpoint}`, undefined, 413);
      expect(incomplete).toMatchObject({
        code: "QA_DEBUG_SNAPSHOT_INCOMPLETE",
        maxBytes: 64 * 1024,
        requests: [{ cursor: 1, omittedFields: input.omittedFields }],
      });
      expect(incomplete.error).toContain("/debug/request-cursor");
      expect(incomplete.requests[0].facts.model).toBe("aimock/gpt-5.6-luna");
      for (const field of input.omittedFields) {
        expect(incomplete.requests[0].facts).not.toHaveProperty(field);
      }
      if (input.role === "system") {
        expect(incomplete.requests[0].facts.prompt).toBe("exact current user");
      }
      expect(Buffer.byteLength(JSON.stringify(incomplete.requests[0]))).toBeLessThan(64 * 1024);
    }
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: 1 });
    expect(await json(`/debug/image-generations`)).toEqual([]);
    expect((await fetch(`${server.baseUrl}/debug/requests?after=1.5`)).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/debug/requests?after=2`)).status).toBe(409);

    await post([{ role: "user", content: "later complete request" }]);
    expect(await json(`/debug/last-request`)).toMatchObject({ prompt: "later complete request" });
    expect(await json(`/debug/requests?after=1`)).toMatchObject([
      { prompt: "later complete request" },
    ]);
    expect((await fetch(`${server.baseUrl}/debug/requests`)).status).toBe(413);

    const reset = await fetch(`${server.baseUrl}/__aimock/reset/journal`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(await json(`/debug/requests`)).toEqual([]);
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: 2 });
    await post([{ role: "user", content: "after reset" }]);
    expect(await json(`/debug/requests?after=2`)).toMatchObject([{ prompt: "after reset" }]);
    expect((await fetch(`${server.baseUrl}/__aimock/reset`, { method: "POST" })).status).toBe(200);
    expect(await json(`/debug/requests`)).toEqual([]);
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: 3 });
  });

  it("preserves image evidence and tool-call pairing across capped journal bodies", async () => {
    const prompt = "inspect and use echo";
    const user = {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: "data:image/png;base64,cWE=" } },
      ],
    };
    const postWithTools = (messages: unknown[]) =>
      post(messages, {
        tools: [
          {
            type: "function",
            function: { name: "echo", description: "t".repeat(70_000), parameters: {} },
          },
        ],
      });
    expect((await fetch(`${server.baseUrl}/__aimock/fixtures`, { method: "DELETE" })).status).toBe(
      200,
    );
    await json(`/__aimock/fixtures`, {
      fixtures: [
        {
          match: { sequenceIndex: 0 },
          response: { toolCalls: [{ name: "echo", arguments: "{}" }] },
        },
        { match: { sequenceIndex: 1 }, response: { content: "tool observed" } },
      ],
    });
    const planned = await postWithTools([user]);
    const assistant = planned.choices[0].message;
    const toolCallId = assistant.tool_calls[0].id;
    await postWithTools([
      user,
      assistant,
      {
        role: "tool",
        content: "independent tool evidence",
        tool_call_id: toolCallId,
        isError: true,
      },
      {
        role: "user",
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    ]);
    const requests = await json(`/debug/requests`);
    expect(requests).toMatchObject([
      {
        prompt,
        imageInputCount: 1,
        plannedToolName: "echo",
        plannedToolCallId: toolCallId,
        body: { __aimock_truncated: true },
      },
      {
        prompt,
        imageInputCount: 1,
        toolOutput: "independent tool evidence",
        toolOutputCallId: toolCallId,
        toolOutputStructuredError: true,
        body: { __aimock_truncated: true },
      },
    ]);
  });

  it.each([
    { label: "complete", olderOverflow: false, olderPrompt: "first conversation" },
    { label: "overflow", olderOverflow: true, olderPrompt: "first conversation" },
    { label: "near-budget prompt", olderOverflow: true, olderPrompt: "u".repeat(65_280) },
  ])(
    "keeps tool-result pairing before the selected cursor window ($label)",
    async ({ olderOverflow, olderPrompt }) => {
      await fetch(`${server.baseUrl}/__aimock/fixtures`, { method: "DELETE" });
      const fixtures = [0, 1].map((sequenceIndex) => ({
        match: { sequenceIndex },
        response: { toolCalls: [{ name: "echo", arguments: "{}" }] },
      }));
      await json(`/__aimock/fixtures`, {
        fixtures: [...fixtures, { match: { sequenceIndex: 2 }, response: { content: "done" } }],
      });
      const first = await post([
        ...(olderOverflow ? [{ role: "system", content: "s".repeat(70_000) }] : []),
        { role: "user", content: olderPrompt },
      ]);
      await post([{ role: "user", content: "second conversation" }]);
      const firstToolCallId = first.choices[0].message.tool_calls[0].id;
      await post([
        { role: "user", content: "first conversation" },
        first.choices[0].message,
        { role: "tool", content: "first result", tool_call_id: firstToolCallId },
      ]);
      const selected = await json(`/debug/requests?after=1`);
      expect(selected).toHaveLength(2);
      expect(selected[0]).toMatchObject({
        prompt: "second conversation",
        plannedToolName: "echo",
      });
      expect(selected[0]).not.toHaveProperty("plannedToolCallId");
      expect(selected[1]).toMatchObject({ toolOutputCallId: firstToolCallId });
      if (olderOverflow) {
        const incomplete = await json(`/debug/requests`, undefined, 413);
        expect(incomplete.requests[0].facts.plannedToolCallId).toBe(firstToolCallId);
        expect(incomplete.requests[0].omittedFields).not.toContain("plannedToolCallId");
      }
    },
  );

  it("reads requests after a stable debug cursor", async () => {
    const postResponse = (text: string, instructions?: string) =>
      json("/v1/responses", {
        model: "aimock/gpt-5.6-luna",
        stream: false,
        input: [makeResponsesInput(text)],
        instructions,
      });
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: 0 });
    const debugRequestLimit = 1_000;
    for (let index = 0; index < debugRequestLimit; index += 1) {
      await postResponse(`aimock cursor ${index}`, index === 0 ? "s".repeat(70_000) : undefined);
    }
    expect(await json(`/debug/request-cursor`)).toEqual({ cursor: debugRequestLimit });
    expect((await fetch(`${server.baseUrl}/debug/requests`)).status).toBe(413);
    await postResponse("aimock cursor overflow");

    const retained = (await json(`/debug/requests`)) as Array<{ prompt?: unknown }>;
    expect(retained).toHaveLength(debugRequestLimit);
    expect(retained[0]?.prompt).toBe("aimock cursor 1");
    expect(retained.at(-1)?.prompt).toBe("aimock cursor overflow");

    const requests = (await json(`/debug/requests?after=${debugRequestLimit}`)) as Array<{
      prompt?: unknown;
    }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("aimock cursor overflow");

    const expired = await json(`/debug/requests?after=0`, undefined, 409);
    expect(expired).toEqual({
      error: "request cursor expired",
      after: 0,
      oldestCursor: 2,
      latestCursor: debugRequestLimit + 1,
    });

    const futureCursor = debugRequestLimit + 2;
    const future = await json(`/debug/requests?after=${futureCursor}`, undefined, 409);
    expect(future).toEqual({
      error: "request cursor is ahead of the latest recorded request",
      after: futureCursor,
      latestCursor: debugRequestLimit + 1,
    });
  });

  it("treats OpenAI Codex model refs as OpenAI-compatible snapshots", async () => {
    await json(`/v1/responses`, {
      model: "openai/gpt-5.6-luna",
      stream: false,
      input: [makeResponsesInput("hello codex-compatible aimock")],
    });

    const debug = await json(`/debug/last-request`);
    const expectedBody = {
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "hello codex-compatible aimock" }],
      stream: false,
      _endpointType: "chat",
    };
    expect(debug).toEqual({
      raw: JSON.stringify(expectedBody),
      body: expectedBody,
      prompt: "hello codex-compatible aimock",
      allInputText: "hello codex-compatible aimock",
      toolOutput: "",
      model: "openai/gpt-5.6-luna",
      providerVariant: "openai",
      imageInputCount: 0,
    });
  });
});
