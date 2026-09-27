import { describe, expect, it } from "vitest";
import {
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItem,
  outputItems,
  outputText,
  outputToolArgs,
  outputToolCall,
  outputToolCallId,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("mock OpenAI A2A scenarios", () => {
  it("plans sessions_send for the A2A message-tool mirror proof scenario", async () => {
    const server = await startMockServer();
    const prompt =
      'qa a2a message-tool mirror check. sessionKey="agent:qa:a2a-target". exact marker: `QA-A2A-MIRROR-OK`';

    const toolPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "sessions_send" }],
      input: [makeUserInput(prompt)],
    });

    const args = outputToolArgs(toolPlan);
    expect(outputItem(toolPlan).type).toBe("function_call");
    expect(outputItem(toolPlan).name).toBe("sessions_send");
    expect(args).toMatchObject({
      sessionKey: "agent:qa:a2a-target",
      timeoutSeconds: 0,
    });
    expect(String(args.message)).toContain("qa group visible reply tool check");
    expect(String(args.message)).toContain("QA-A2A-MIRROR-OK");

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.plannedToolName).toBe("sessions_send");
    expect(debugPayload.plannedToolArgs).toMatchObject({
      sessionKey: "agent:qa:a2a-target",
      timeoutSeconds: 0,
    });

    const final = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "sessions_send" }],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_sessions_send_fixture",
          JSON.stringify({ status: "accepted", delivery: { mode: "announce" } }),
        ),
      ],
    });
    expect(outputText(final)).toBe("");
    expect(outputItems(final).some((item) => item.type === "function_call")).toBe(false);

    const targetToolPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [
        { type: "function", name: "sessions_send" },
        { type: "function", name: "message" },
      ],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "qa group visible reply tool check. Use the visible room reply path. exact marker: `QA-A2A-MIRROR-OK`",
        ),
      ],
    });

    expect(outputItem(targetToolPlan).type).toBe("function_call");
    expect(outputItem(targetToolPlan).name).toBe("message");
    expect(outputToolArgs(targetToolPlan)).toMatchObject({
      action: "send",
      message: "QA-A2A-MIRROR-OK",
    });
  });

  it.each([
    {
      policy: "disabled",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    },
    {
      policy: "allowlist",
      error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
    },
  ])("keeps the A2A $policy denial fixture empty during finalization", async ({ error }) => {
    const server = await startMockServer();
    const kickoff = makeUserInput(
      'qa a2a message-tool mirror check. sessionKey="agent:orion:main". exact marker: `QA-A2A-DENIED-OK`',
    );
    const tools = [{ type: "function", name: "sessions_send" }];
    const toolPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [kickoff],
    });
    const toolCall = outputToolCall(toolPlan, "sessions_send");
    const input: unknown[] = [
      kickoff,
      toolCall,
      makeToolOutputWithCallId(
        outputToolCallId(toolCall, "call_a2a_denied"),
        JSON.stringify({ status: "forbidden", error }),
      ),
    ];
    let response = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputText(response)).toBe("");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      input.push(
        ...outputItems(response),
        makeUserInput(
          `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION} If a tool failed, say so; never claim completion or success.`,
        ),
      );
      response = await expectOpenAiNonStreamingResponsesJson(server, { tools: [], input });
      expect(outputText(response)).toBe("");
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    }
  });

  it.each([false, true])(
    "does not revive an earlier A2A fixture after a new user turn (finalization=%s)",
    async (finalization) => {
      const server = await startMockServer();
      const response = await expectOpenAiNonStreamingResponsesJson(server, {
        tools: [],
        input: [
          makeUserInput(
            'qa a2a message-tool mirror check. sessionKey="agent:orion:main". exact marker: `QA-A2A-OLD`',
          ),
          makeToolOutputWithCallId("call_a2a_old", JSON.stringify({ status: "forbidden" })),
          makeUserInput("New request. Reply with exact marker: `QA-NEXT-USER-OK`"),
          ...(finalization
            ? [makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION)]
            : []),
        ],
      });
      expect(outputText(response)).toBe("QA-NEXT-USER-OK");
      expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
    },
  );

  it("does not revive projected A2A history during the current request's finalization", async () => {
    const server = await startMockServer();
    const response = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [],
      input: [
        makeUserInput(
          [
            "<conversation_context>",
            "[user]",
            'qa a2a message-tool mirror check. sessionKey="agent:orion:main". exact marker: `QA-A2A-OLD`',
            "</conversation_context>",
            "",
            "Current user request:",
            "New request. Reply with exact marker: `QA-NEXT-USER-OK`",
          ].join("\n"),
        ),
        { type: "function_call", name: "read", call_id: "call_current", arguments: "{}" },
        makeToolOutputWithCallId("call_current", JSON.stringify({ ok: true })),
        makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
      ],
    });
    expect(outputText(response)).toBe("QA-NEXT-USER-OK");
    expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
  });
});
