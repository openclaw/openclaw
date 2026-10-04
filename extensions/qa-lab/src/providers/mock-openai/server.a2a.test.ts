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
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const oldPrompt =
  'qa a2a message-tool mirror check. sessionKey="agent:orion:main". exact marker: `QA-A2A-OLD`';
const nextPrompt = "New request. Reply with exact marker: `QA-NEXT-USER-OK`";

function expectTextOnly(response: unknown, text: string) {
  expect(outputText(response)).toBe(text);
  expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
}

describe("mock OpenAI A2A scenarios", () => {
  it.each([
    {
      sessionKey: "agent:qa:a2a-target",
      marker: "QA-A2A-MIRROR-OK",
      receipt: { status: "accepted", delivery: { mode: "announce" } },
    },
    {
      sessionKey: "agent:orion:main",
      marker: "QA-A2A-DENIED-OK",
      receipt: {
        status: "forbidden",
        error:
          "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
      },
    },
  ])(
    "keeps $receipt.status sends empty through finalization",
    async ({ sessionKey, marker, receipt }) => {
      const server = await startMockServer();
      const kickoff = makeUserInput(
        `qa a2a message-tool mirror check. sessionKey="${sessionKey}". exact marker: \`${marker}\``,
      );
      const tools = [{ type: "function", name: "sessions_send" }];
      const plan = await expectOpenAiNonStreamingResponsesJson(server, { tools, input: [kickoff] });
      const call = outputToolCall(plan, "sessions_send");
      expect(outputItem(plan)).toMatchObject({ type: "function_call", name: "sessions_send" });
      const args = outputToolArgs(plan);
      expect(args).toMatchObject({ sessionKey, timeoutSeconds: 0 });
      expect(String(args.message)).toContain("qa group visible reply tool check");
      expect(String(args.message)).toContain(marker);
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_send",
        plannedToolArgs: { sessionKey, timeoutSeconds: 0 },
      });
      const input: unknown[] = [
        kickoff,
        call,
        makeToolOutputWithCallId(outputToolCallId(call, "call_a2a"), JSON.stringify(receipt)),
      ];
      const response = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
      expectTextOnly(response, "");
      expectTextOnly(
        await expectOpenAiNonStreamingResponsesJson(server, {
          tools: [],
          input: [
            ...input,
            ...outputItems(response),
            makeUserInput(
              `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION} If a tool failed, say so; never claim completion or success.`,
            ),
          ],
        }),
        "",
      );

      const target = await expectOpenAiNonStreamingResponsesJson(server, {
        tools: [...tools, { type: "function", name: "message" }],
        input: [
          kickoff,
          makeUserInput(
            `qa group visible reply tool check. Use the visible room reply path. exact marker: \`${marker}\``,
          ),
        ],
      });
      expect(outputItem(target)).toMatchObject({ type: "function_call", name: "message" });
      expect(outputToolArgs(target)).toMatchObject({ action: "send", message: marker });
    },
  );

  it.each([
    {
      history: "earlier turn",
      input: [
        makeUserInput(oldPrompt),
        makeToolOutputWithCallId("call_a2a_old", JSON.stringify({ status: "forbidden" })),
        makeUserInput(nextPrompt),
      ],
    },
    {
      history: "projected conversation",
      input: [
        makeUserInput(
          `<conversation_context>\n[user]\n${oldPrompt}\n</conversation_context>\n\nCurrent user request:\n${nextPrompt}`,
        ),
        { type: "function_call", name: "read", call_id: "call_current", arguments: "{}" },
        makeToolOutputWithCallId("call_current", JSON.stringify({ ok: true })),
      ],
    },
  ])("does not revive $history during current finalization", async ({ input }) => {
    const server = await startMockServer();
    expectTextOnly(
      await expectOpenAiNonStreamingResponsesJson(server, {
        tools: [],
        input: [...input, makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION)],
      }),
      "QA-NEXT-USER-OK",
    );
  });
});
