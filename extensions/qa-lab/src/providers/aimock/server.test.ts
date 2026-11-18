import { getTextContent, type Fixture } from "@copilotkit/aimock";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startQaAimockServer } from "./server.js";

const model = "aimock/gpt-5.6-luna";
const message = (content: string, role = "user") => ({ role, content });
const makeResponsesInput = (text: string) => ({
  role: "user" as const,
  content: [{ type: "input_text" as const, text }],
});
const context = (text: string, separator = "\n") =>
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", text, "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"].join(
    separator,
  );
const echo = { name: "echo", arguments: "{}" };
const largeTool = {
  type: "function",
  function: { name: "echo", description: "t".repeat(70_000), parameters: {} },
};
const toolResult = (content: string, tool_call_id: string) => ({
  role: "tool",
  content,
  tool_call_id,
});

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
      model,
      stream: false,
      messages,
      ...extra,
    });
  const responses = (text: string, extra: Record<string, unknown> = {}) =>
    json("/v1/responses", { model, stream: false, input: [makeResponsesInput(text)], ...extra });
  const debug = (path: string, code = 200) => json(`/debug/${path}`, undefined, code);
  const matches = async (path: string, expected: Record<string, unknown> | unknown[]) =>
    expect(await debug(path)).toMatchObject(expected);
  const equals = async (path: string, expected: unknown) =>
    expect(await debug(path)).toEqual(expected);
  const fixtures = (...entries: Fixture[]) => json("/__aimock/fixtures", { fixtures: entries });
  const plan = (sequenceIndex: number): Fixture => ({
    match: { sequenceIndex },
    response: { toolCalls: [echo] },
  });
  async function status(path: string, expected: number, method = "GET") {
    expect((await fetch(`${server.baseUrl}${path}`, { method })).status).toBe(expected);
  }

  it("matches programmatic fixtures across trailing runtime context without rewriting requests", async () => {
    const client = new OpenAI({
      baseURL: `${server.baseUrl}/v1`,
      apiKey: "qa-local",
      maxRetries: 0,
    });
    const userText = [
      context("Task context", "\n\n"),
      "Recover the research answer",
      context("Begin the task.", "\n\n"),
    ].join("\n\n");
    const toolOutput = "approval-unavailable: initiating-platform-disabled";
    const carrier = context("Synthetic runtime context");
    const fn = { name: "exec", arguments: "{}" };
    const call = { type: "function_call" as const, call_id: "call_shell", ...fn };
    const request = (text: string, output: string) =>
      client.responses.create({
        model: "openai/gpt-5.6-luna",
        stream: false,
        input: [
          makeResponsesInput(text),
          call,
          { type: "function_call_output", call_id: call.call_id, output },
          makeResponsesInput(carrier),
        ],
      });
    await json("/__aimock/reset", {});
    server.addFixture({
      match: {
        predicate: (body) => {
          const tool = body.messages.findLast((entry) => entry.role === "tool");
          return (
            body.messages.some(
              (entry) => entry.role === "user" && getTextContent(entry.content) === userText,
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
    const snapshot = await debug("last-request");
    expect(snapshot.body.messages).toEqual([
      message(userText),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: call.call_id, type: "function", function: fn }],
      },
      toolResult(toolOutput, call.call_id),
      message(carrier),
    ]);
    expect(JSON.parse(snapshot.raw)).toEqual(snapshot.body);
    expect(snapshot).toMatchObject({
      model: "openai/gpt-5.6-luna",
      body: { model: "openai/gpt-5.6-luna", stream: false, _endpointType: "chat" },
      providerVariant: "openai",
      imageInputCount: 0,
      prompt: userText,
      toolOutput,
      toolOutputCallId: call.call_id,
      plannedToolCallId: "call_read",
    });
    expect((await json(`/__aimock/journal`)).at(-1).body).toEqual(snapshot.body);

    const registered = await fixtures({
      match: { userMessage: "ordinary HTTP fixture" },
      response: { content: "HTTP_MATCH_OK" },
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
    await post([message(prompt)]);
    await json("/v1/images/generations", { model: "dall-e-3" }, 400);

    await equals("image-generations", [{}]);
    await equals("request-cursor", { cursor: 1 });
    await equals("requests", [expect.objectContaining({ prompt })]);
    await matches("last-request", { prompt, allInputText: prompt, toolOutput: "" });
  });

  it("retains Responses facts beyond the journal cap", async () => {
    const prompt = "current user marker";
    await json("/v1/responses", {
      model,
      stream: false,
      input: [
        makeResponsesInput(prompt),
        { type: "function_call_output", output: "observed tool output", call_id: "call-qa" },
      ],
      tools: [{ type: "function", ...largeTool.function }],
    });
    const snapshot = await debug("last-request");
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
  });

  it.each([
    { role: "system", content: "s".repeat(70_000), omittedFields: ["allInputText"] },
    { role: "user", content: "😀".repeat(20_000), omittedFields: ["prompt", "allInputText"] },
  ])("isolates incomplete $role text", async (input) => {
    await post([
      ...(input.role === "system" ? [message("exact current user")] : []),
      message(input.content, input.role),
    ]);
    for (const endpoint of ["last-request", "requests", "requests?after=0"]) {
      const incomplete = await debug(endpoint, 413);
      expect(incomplete).toMatchObject({
        code: "QA_DEBUG_SNAPSHOT_INCOMPLETE",
        maxBytes: 64 * 1024,
        requests: [{ cursor: 1, omittedFields: input.omittedFields, facts: { model } }],
      });
      expect(incomplete.error).toContain("/debug/request-cursor");
      for (const field of input.omittedFields) {
        expect(incomplete.requests[0].facts).not.toHaveProperty(field);
      }
      if (input.role === "system") {
        expect(incomplete.requests[0].facts.prompt).toBe("exact current user");
      }
      expect(Buffer.byteLength(JSON.stringify(incomplete.requests[0]))).toBeLessThan(64 * 1024);
    }
    await equals("request-cursor", { cursor: 1 });
    await equals("image-generations", []);
    await status("/debug/requests?after=1.5", 400);
    await status("/debug/requests?after=2", 409);

    await post([message("later complete request")]);
    await matches("last-request", { prompt: "later complete request" });
    await matches("requests?after=1", [{ prompt: "later complete request" }]);
    await status("/debug/requests", 413);

    await status("/__aimock/reset/journal", 200, "POST");
    await equals("requests", []);
    await equals("request-cursor", { cursor: 2 });
    await post([message("after reset")]);
    await matches("requests?after=2", [{ prompt: "after reset" }]);
    await status("/__aimock/reset", 200, "POST");
    await equals("requests", []);
    await equals("request-cursor", { cursor: 3 });
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
    const postWithTools = (messages: unknown[]) => post(messages, { tools: [largeTool] });
    await status("/__aimock/fixtures", 200, "DELETE");
    await fixtures(plan(0), {
      match: { sequenceIndex: 1 },
      response: { content: "tool observed" },
    });
    const planned = await postWithTools([user]);
    const assistant = planned.choices[0].message;
    const toolCallId = assistant.tool_calls[0].id;
    await postWithTools([
      user,
      assistant,
      { ...toolResult("independent tool evidence", toolCallId), isError: true },
      message(context("private runtime context")),
    ]);
    await matches("requests", [
      {
        prompt,
        allInputText: prompt,
        toolOutput: "",
        model,
        providerVariant: "openai",
        imageInputCount: 1,
        plannedToolName: "echo",
        plannedToolCallId: toolCallId,
        body: { __aimock_truncated: true },
      },
      {
        prompt,
        imageInputCount: 1,
        allInputText: `${prompt}\nindependent tool evidence\n${context("private runtime context")}`,
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
  ])("pairs tools before the cursor ($label)", async ({ olderOverflow, olderPrompt }) => {
    await status("/__aimock/fixtures", 200, "DELETE");
    await fixtures(plan(0), plan(1), {
      match: { sequenceIndex: 2 },
      response: { content: "done" },
    });
    const first = await post([
      ...(olderOverflow ? [message("s".repeat(70_000), "system")] : []),
      message(olderPrompt),
    ]);
    await post([message("second conversation")]);
    const firstToolCallId = first.choices[0].message.tool_calls[0].id;
    await post([
      message("first conversation"),
      first.choices[0].message,
      toolResult("first result", firstToolCallId),
    ]);
    const selected = await debug("requests?after=1");
    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({
      prompt: "second conversation",
      plannedToolName: "echo",
    });
    expect(selected[0]).not.toHaveProperty("plannedToolCallId");
    expect(selected[1]).toMatchObject({ toolOutputCallId: firstToolCallId });
    if (olderOverflow) {
      const incomplete = await debug("requests", 413);
      expect(incomplete.requests[0].facts.plannedToolCallId).toBe(firstToolCallId);
      expect(incomplete.requests[0].omittedFields).not.toContain("plannedToolCallId");
    }
  });

  it("reads requests after a stable debug cursor", async () => {
    await equals("request-cursor", { cursor: 0 });
    const debugRequestLimit = 1_000;
    for (let index = 0; index < debugRequestLimit; index += 1) {
      await responses(`aimock cursor ${index}`, {
        instructions: index === 0 ? "s".repeat(70_000) : undefined,
      });
    }
    await equals("request-cursor", { cursor: debugRequestLimit });
    await status("/debug/requests", 413);
    await responses("aimock cursor overflow");

    const retained = (await debug("requests")) as Array<{ prompt?: unknown }>;
    expect(retained).toHaveLength(debugRequestLimit);
    expect(retained[0]?.prompt).toBe("aimock cursor 1");
    expect(retained.at(-1)?.prompt).toBe("aimock cursor overflow");

    const requests = (await debug(`requests?after=${debugRequestLimit}`)) as Array<{
      prompt?: unknown;
    }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("aimock cursor overflow");

    expect(await debug("requests?after=0", 409)).toEqual({
      error: "request cursor expired",
      after: 0,
      oldestCursor: 2,
      latestCursor: debugRequestLimit + 1,
    });

    const futureCursor = debugRequestLimit + 2;
    expect(await debug(`requests?after=${futureCursor}`, 409)).toEqual({
      error: "request cursor is ahead of the latest recorded request",
      after: futureCursor,
      latestCursor: debugRequestLimit + 1,
    });
  });
});
