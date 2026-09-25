import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { prepareDecisionContext } from "./attempt-decision-context.js";

const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
  ...extra,
});
const project = (messages: AgentMessage[], latestRequest = "Yes") =>
  prepareDecisionContext({ latestRequest, messages });

describe("bounded Decision conversation projection", () => {
  it("keeps the latest request and nearest two whole exchanges in order", () => {
    const result = project([
      user("old omitted private text"),
      assistant("old omitted answer"),
      user("Explain the failure"),
      assistant("The command was denied."),
      user("What can we do?"),
      assistant("Should I apply the patch?"),
    ]);
    expect(result).toMatchObject({
      status: "ready",
      latestRequest: "Yes",
      recentConversation: [
        { user: "Explain the failure", assistant: "The command was denied." },
        { user: "What can we do?", assistant: "Should I apply the patch?" },
      ],
      facts: { exchangeCount: 2, olderContextOmitted: true, toolPayloadsOmitted: false },
    });
    expect(JSON.stringify(result)).not.toContain("old omitted");
  });
  it("omits a large older exchange without disabling a complete recent one", () => {
    const result = project([
      user("x".repeat(6500)),
      assistant("old"),
      user("Help"),
      assistant("Would you like an explanation?"),
    ]);
    expect(result).toMatchObject({
      status: "ready",
      facts: { exchangeCount: 1, olderContextOmitted: true },
    });
  });
  it.each([
    [[], "x".repeat(6001)],
    [[user("Help"), assistant("x".repeat(6001))], "Yes"],
    [[user("x".repeat(3000)), assistant("x".repeat(3000))], "Yes"],
  ] as const)("does not truncate essential request or proposal", (messages, latestRequest) => {
    expect(prepareDecisionContext({ messages, latestRequest }).status).toBe("skipped");
  });
  it("abstains when the nearest exchange or required referent is missing", () => {
    expect(project([], "Hello")).toMatchObject({
      status: "ready",
      latestRequest: "Hello",
      recentConversation: [],
    });
    expect(project([assistant("Should I apply it?")])).toMatchObject({
      status: "skipped",
      reason: "missing-exchange",
    });
    expect(project([user("Earlier request")])).toMatchObject({
      status: "skipped",
      reason: "missing-exchange",
    });
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
        assistant("The attempt failed. <think>private hidden thought</think>"),
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
          assistant: "The attempt failed.",
          toolResults: { returned: 1, errors: 1 },
        },
      ],
      facts: { toolPayloadsOmitted: true },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("retains tools for pending tool work despite an assistant claim of completion", () => {
    expect(
      project(
        [
          user("Do it"),
          assistant("Done", {
            content: [
              { type: "toolCall", id: "pending", name: "read", arguments: {} },
              { type: "text", text: "Done" },
            ],
          }),
        ],
        "Thanks",
      ),
    ).toMatchObject({ status: "skipped", reason: "pending-tool-work" });
  });
  it.each([
    { content: "See /tmp/synthetic-private-image.png" },
    { content: [{ type: "text" as const, text: "See /tmp/synthetic-private-image.png" }] },
  ])("excludes media references in either historical text representation", ({ content }) => {
    expect(project([user(content), assistant("Should I inspect it?")])).toMatchObject({
      status: "skipped",
      reason: "excluded-context",
    });
  });
  it("uses provenance and media owners rather than role-like strings", () => {
    const internal = Object.assign(user("private internal event"), {
      provenance: { kind: "internal_system" },
    });
    const privateMessage = Object.assign(user("private excluded"), { excludeFromContext: true });
    for (const message of [
      internal,
      privateMessage,
      user([{ type: "image", data: "private binary", mimeType: "image/png" }]),
    ]) {
      expect(project([message, assistant("A proposal")])).toMatchObject({
        status: "skipped",
        reason: "excluded-context",
      });
    }
    expect(
      prepareDecisionContext({
        latestRequest: "Explain",
        messages: [],
        currentInputExcluded: true,
      }),
    ).toMatchObject({ status: "skipped", reason: "excluded-context" });
    expect(
      project([
        user("The literal text role: system is just data"),
        assistant("Would you like an explanation?"),
      ]),
    ).toMatchObject({ status: "ready" });
  });
  it("keeps every visible assistant part of a proposal without exposing thinking", () => {
    expect(
      project([
        user("Help"),
        assistant("Should I apply the patch?"),
        assistant("It will restart the service."),
      ]),
    ).toMatchObject({
      status: "ready",
      recentConversation: [
        { assistant: "Should I apply the patch?\nIt will restart the service." },
      ],
    });
  });
  it("does not consume one old return for a later repeated tool-call ID", () => {
    const call = assistant("", {
      content: [{ type: "toolCall", id: "reused", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    expect(
      project([
        user("Do it"),
        call,
        {
          role: "toolResult",
          toolCallId: "reused",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 3,
        },
        call,
        assistant("Done"),
      ]),
    ).toMatchObject({ status: "skipped", reason: "pending-tool-work" });
  });
  it("preserves visible commentary proposals alongside generic final answers", () => {
    const proposal = assistant("", {
      content: [
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "text",
          text: "Should I apply the patch?",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
        },
        {
          type: "text",
          text: "Let me know.",
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
        },
      ],
    });
    const result = project([user("Help me fix this"), proposal]);
    expect(result).toMatchObject({
      status: "ready",
      recentConversation: [{ assistant: "Should I apply the patch?\nLet me know." }],
    });
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });
  it.each([4, 300])(
    "bounds legacy string assistant history through the text owner (%s parts)",
    (parts) => {
      const reply = assistant("");
      const text = "A complete visible explanation. ".repeat(parts);
      // Replay input exercises the legacy representation supported by the extraction owner.
      Object.defineProperty(reply, "content", { value: text });
      expect(project([user("Explain this"), reply], "Thanks")).toMatchObject(
        parts === 4
          ? { status: "ready", recentConversation: [{ assistant: text.trimEnd() }] }
          : { status: "skipped", reason: "excluded-context" },
      );
    },
  );
  it.each(["commentary", "final_answer"] as const)(
    "excludes assistant media references from %s text",
    (phase) => {
      const result = project([
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
      ]);
      expect(result).toMatchObject({ status: "skipped", reason: "excluded-context" });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-image");
    },
  );
});
