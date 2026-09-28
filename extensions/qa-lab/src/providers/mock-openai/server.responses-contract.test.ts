import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  expectResponses,
  guestCodeModeExecTool,
  makeUserInput,
  outputToolArgs,
  outputItem,
  outputToolCallId,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("mock Responses contract", () => {
  it("returns a completed JSON Response when stream is omitted", async () => {
    const response = await expectResponses(await startMockServer(), {
      model: "qa-model",
      input: [makeUserInput("Reply exactly: QA-RESPONSE-CONTRACT")],
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "QA-RESPONSE-CONTRACT" }],
        },
      ],
    });
  });

  it.each(["mcp code mode qa check", "mcp code mode api file qa check"])(
    "uses the JavaScript-only exec contract for %s",
    async (prompt) => {
      const body = await expectOpenAiNonStreamingResponsesJson(await startMockServer(), {
        model: "qa-model",
        input: [{ role: "user", content: prompt }],
        tools: [{ type: "function", name: "exec", parameters: guestCodeModeExecTool.parameters }],
      });
      const call = outputItem(body);
      expect(call).toMatchObject({
        type: "function_call",
        name: "exec",
        call_id: expect.any(String),
      });
      const args = outputToolArgs(body);
      validateToolArguments(guestCodeModeExecTool, {
        type: "toolCall",
        id: outputToolCallId(call, "exec"),
        name: "exec",
        arguments: args,
      });
      expect(args).toEqual({ title: expect.any(String), code: expect.any(String) });
    },
  );
});
