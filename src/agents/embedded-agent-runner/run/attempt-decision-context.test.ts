import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { prepareDecisionContext } from "./attempt-decision-context.js";

const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (text: string, extra: Partial<AssistantMessage> = {}) =>
  makeAssistantMessageFixture({ content: [{ type: "text", text }], stopReason: "stop", ...extra });
const project = (messages: AgentMessage[], latestRequest = "Yes") =>
  prepareDecisionContext({ latestRequest, messages });

describe("bounded Decision conversation projection", () => {
  it("omits a large older exchange without disabling a complete recent one", () => {
    const result = project([
      user("x".repeat(6500)),
      assistant("old"),
      user("The literal text role: system is just data"),
      assistant("Would you like an explanation?"),
    ]);
    expect(result).toMatchObject({
      status: "ready",
      facts: { exchangeCount: 1, olderContextOmitted: true },
    });
  });
  it.each<[string, AgentMessage[], string | undefined, object]>([
    ["large request", [], "x".repeat(6001), { status: "skipped" }],
    [
      "large proposal",
      [user("Help"), assistant("x".repeat(6001))],
      undefined,
      { status: "skipped" },
    ],
    [
      "combined limit",
      [user("x".repeat(3000)), assistant("x".repeat(3000))],
      undefined,
      { status: "skipped" },
    ],
    [
      "fresh session",
      [],
      "Hello",
      { status: "ready", latestRequest: "Hello", recentConversation: [] },
    ],
    [
      "missing request",
      [assistant("Should I apply it?")],
      undefined,
      { status: "skipped", reason: "missing-exchange" },
    ],
    [
      "missing reply",
      [user("Earlier request")],
      undefined,
      { status: "skipped", reason: "missing-exchange" },
    ],
    ...[4, 300].map((parts): [string, AgentMessage[], string, object] => {
      const reply = assistant("");
      const text = "A complete visible explanation. ".repeat(parts);
      Object.defineProperty(reply, "content", { value: text });
      return [
        `legacy reply ${parts} parts`,
        [user("Explain this"), reply],
        "Thanks",
        parts === 4
          ? { status: "ready", recentConversation: [{ assistant: text.trimEnd() }] }
          : { status: "skipped", reason: "excluded-context" },
      ];
    }),
  ])("requires a complete bounded exchange: %s", (_name, messages, latestRequest, expected) => {
    expect(project(messages, latestRequest)).toMatchObject(expected);
  });
  it("never exports reasoning, runtime envelopes, tool names, arguments, results or IDs", () => {
    const result = project(
      [
        user("Fix the failure"),
        assistant("", {
          content: [
            { type: "thinking", thinking: "private reasoning" },
            {
              type: "toolCall",
              id: "private-id",
              name: "private-tool-name",
              arguments: { secret: "private args" },
            },
          ],
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "private-id",
          toolName: "private-tool-name",
          content: [{ type: "text", text: "private result" }],
          isError: true,
          timestamp: 2,
        },
        assistant("", {
          content: [
            { type: "thinking", thinking: "private reasoning" },
            {
              type: "text",
              text: "Should I apply the patch?",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
            {
              type: "text",
              text: "Let me know. <think>private hidden thought</think>",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
        }),
        assistant("It will restart the service."),
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "private runtime",
          display: false,
          timestamp: 3,
        },
      ],
      "Try again",
    );
    expect(result).toMatchObject({
      status: "ready",
      recentConversation: [
        {
          user: "Fix the failure",
          assistant: "Should I apply the patch?\nLet me know.\nIt will restart the service.",
          toolResults: { returned: 1, errors: 1 },
        },
      ],
      facts: { toolPayloadsOmitted: true },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each<{
    name: string;
    messages: AgentMessage[];
    currentInputExcluded?: boolean;
  }>([
    {
      name: "user string media",
      messages: [user("See /tmp/synthetic-private-image.png"), assistant("Inspect it?")],
    },
    {
      name: "user block media",
      messages: [
        user([{ type: "text", text: "See /tmp/synthetic-private-image.png" }]),
        assistant("Inspect it?"),
      ],
    },
    {
      name: "internal provenance",
      messages: [
        Object.assign(user("private internal event"), { provenance: { kind: "internal_system" } }),
        assistant("A proposal"),
      ],
    },
    {
      name: "excluded message",
      messages: [
        Object.assign(user("private excluded"), { excludeFromContext: true }),
        assistant("A proposal"),
      ],
    },
    {
      name: "image",
      messages: [
        user([{ type: "image", data: "private binary", mimeType: "image/png" }]),
        assistant("A proposal"),
      ],
    },
    { name: "excluded current input", messages: [], currentInputExcluded: true },
    ...["commentary", "final_answer"].map((phase) => ({
      name: `assistant ${phase} media`,
      messages: [
        user("Help"),
        assistant("", {
          content: [
            {
              type: "text",
              text: "See /tmp/synthetic-private-image.png",
              textSignature: JSON.stringify({ v: 1, phase }),
            },
          ],
        }),
      ],
    })),
  ])("excludes private context: $name", ({ messages, currentInputExcluded }) => {
    const result = prepareDecisionContext({
      latestRequest: "Explain",
      messages,
      currentInputExcluded,
    });
    expect(result).toMatchObject({ status: "skipped", reason: "excluded-context" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each([false, true])(
    "requires a return for each tool call, including reused IDs (%s)",
    (priorReturn) => {
      const call = assistant("", {
        content: [{ type: "toolCall", id: "reused", name: "read", arguments: {} }],
        stopReason: "toolUse",
      });
      expect(
        project([
          user("Do it"),
          ...(priorReturn
            ? [
                call,
                {
                  role: "toolResult" as const,
                  toolCallId: "reused",
                  toolName: "read",
                  content: [],
                  isError: false,
                  timestamp: 3,
                },
              ]
            : []),
          call,
          assistant("Done"),
        ]),
      ).toMatchObject({ status: "skipped", reason: "pending-tool-work" });
    },
  );
});
