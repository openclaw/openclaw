import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  getJson,
  makeUserInput,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("mock Responses input text", () => {
  it("reads string message content", async () => {
    const server = await startMockServer();
    const response = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "qa-model",
      input: [{ role: "user", content: "Reply exactly: QA-MESSAGE-CONTENT" }],
    });
    expect(response).toMatchObject({
      output: [{ type: "message", content: [{ type: "output_text", text: "QA-MESSAGE-CONTENT" }] }],
    });
  });

  it.each([
    {
      name: "ignores a runtime carrier before continuation",
      laterInput: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "OpenClaw runtime context:\nRuntime: synthetic metadata.",
            },
          ],
        },
        makeUserInput("Continue."),
      ],
      requestKind: "tool-continuation",
    },
    {
      name: "fences completed tools with an empty user message after continuation",
      laterInput: [
        { role: "user", content: "Continue." },
        { role: "user", content: [] },
      ],
      requestKind: "agent-initial",
    },
  ])("$name", async ({ laterInput, requestKind }) => {
    const server = await startMockServer();
    await expectOpenAiNonStreamingResponsesJson(server, {
      model: "qa-model",
      input: [
        makeUserInput("Tool progress QA check: read `QA.md` before answering."),
        {
          type: "function_call",
          id: "fc_fixture",
          call_id: "fixture_call",
          name: "read",
          arguments: '{"path":"QA.md"}',
        },
        { type: "function_call_output", call_id: "fixture_call", output: "fixture result" },
        ...laterInput,
      ],
    });
    const snapshot = await getJson(server, "/debug/last-request");
    expect(snapshot).toMatchObject({ requestKind });
    if (requestKind === "agent-initial") {
      expect(snapshot).not.toHaveProperty("plannedToolName");
    }
  });
});
