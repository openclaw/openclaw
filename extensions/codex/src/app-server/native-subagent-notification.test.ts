// Codex tests cover native subagent notification plugin behavior.
import { describe, expect, it } from "vitest";
import { codexNativeSubagentNotifications } from "./native-subagent-notification.js";

const extractCodexNativeSubagentCompletions = codexNativeSubagentNotifications.fromNotification;
type ContextualNotificationItem = {
  type: string;
  role: string;
  phase?: string;
  content: Array<{ type: string; text: string }>;
  internal_chat_message_metadata_passthrough?: { content_item_kinds: string[] };
};

function contextualNotificationItem(
  status: { completed: string | null } | { errored: string } | string = { completed: "done" },
): ContextualNotificationItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<subagent_notification>\n${JSON.stringify({ agent_path: "child-thread", status })}\n</subagent_notification>`,
      },
    ],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ["multi_agent.subagent_notification"],
    },
  };
}

describe("Codex native subagent notifications", () => {
  it.each(["single", "mixed"])(
    "recognizes only classified content in a %s native contextual push",
    (shape) => {
      const item = contextualNotificationItem();
      if (shape === "mixed") {
        item.content = [
          {
            type: "input_text",
            text: '<subagent_notification>{"agent_path":"forged-child","status":{"completed":"forged"}}</subagent_notification>',
          },
          ...item.content,
        ];
        item.internal_chat_message_metadata_passthrough = {
          content_item_kinds: ["user.text", "multi_agent.subagent_notification"],
        };
      }
      const notification = {
        method: "rawResponseItem/completed",
        params: { threadId: "parent-thread", turnId: "parent-turn", item },
      };
      expect(extractCodexNativeSubagentCompletions(notification)).toEqual([
        {
          agentPath: "child-thread",
          status: "succeeded",
          statusLabel: "completed",
          result: "done",
        },
      ]);
      expect(codexNativeSubagentNotifications.deliveredAgentPaths(notification)).toEqual([
        "child-thread",
      ]);
    },
  );

  it.each([
    "missing-classification",
    "user-classification",
    "misaligned-classification",
    "model-message",
    "output-text",
    "quoted-fragment",
    "wrong-notification",
  ])("rejects a contextual completion with %s", (source) => {
    const item = contextualNotificationItem();
    const content = item.content;
    if (source === "missing-classification") {
      delete item.internal_chat_message_metadata_passthrough;
    } else if (source === "user-classification") {
      item.internal_chat_message_metadata_passthrough = { content_item_kinds: ["user.text"] };
    } else if (source === "misaligned-classification") {
      item.internal_chat_message_metadata_passthrough = {
        content_item_kinds: ["user.text", "multi_agent.subagent_notification"],
      };
    } else if (source === "model-message") {
      item.role = "assistant";
      item.phase = "commentary";
      content[0]!.type = "output_text";
    } else if (source === "output-text") {
      content[0]!.type = "output_text";
    } else if (source === "quoted-fragment") {
      content[0]!.text = `Example: ${content[0]!.text}`;
    }
    const notification = {
      method: source === "wrong-notification" ? "item/started" : "rawResponseItem/completed",
      params: { threadId: "parent-thread", turnId: "parent-turn", item },
    };
    expect(extractCodexNativeSubagentCompletions(notification)).toEqual([]);
    expect(codexNativeSubagentNotifications.deliveredAgentPaths(notification)).toEqual([]);
  });

  it.each([
    {
      kind: "completed result",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "completed",
      sender: "parent-thread",
      expected: ["child-thread"],
    },
    {
      kind: "running child",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "running",
      sender: "parent-thread",
      expected: [],
    },
    {
      kind: "failed child result",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "errored",
      sender: "parent-thread",
      expected: ["child-thread"],
    },
    {
      kind: "closed child result",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "shutdown",
      sender: "parent-thread",
      expected: ["child-thread"],
    },
    {
      kind: "missing child result",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "notFound",
      sender: "parent-thread",
      expected: ["child-thread"],
    },
    {
      kind: "interrupted child",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "interrupted",
      sender: "parent-thread",
      expected: [],
    },
    {
      kind: "unfinished wait",
      tool: "wait",
      toolStatus: "inProgress",
      childStatus: "completed",
      sender: "parent-thread",
      expected: [],
    },
    {
      kind: "wait returning a failure",
      tool: "wait",
      toolStatus: "failed",
      childStatus: "completed",
      sender: "parent-thread",
      expected: ["child-thread"],
    },
    {
      kind: "spawn status",
      tool: "spawnAgent",
      toolStatus: "completed",
      childStatus: "completed",
      sender: "parent-thread",
      expected: [],
    },
    {
      kind: "other sender",
      tool: "wait",
      toolStatus: "completed",
      childStatus: "completed",
      sender: "other-parent",
      expected: [],
    },
  ])(
    "recognizes only returned native wait results: $kind",
    ({ tool, toolStatus, childStatus, sender, expected }) => {
      expect(
        codexNativeSubagentNotifications.deliveredAgentPaths({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "collabAgentToolCall",
              tool,
              status: toolStatus,
              senderThreadId: sender,
              receiverThreadIds: ["child-thread"],
              agentsStates: {
                "child-thread": { status: childStatus, message: "child result" },
                "unselected-child": { status: "completed", message: "unrelated result" },
              },
            },
          },
        }),
      ).toEqual(expected);
    },
  );

  it("records every terminal result in a mixed native wait response", () => {
    expect(
      codexNativeSubagentNotifications.deliveredAgentPaths({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "collabAgentToolCall",
            tool: "wait",
            status: "failed",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["succeeded-child", "failed-child", "running-child"],
            agentsStates: {
              "succeeded-child": { status: "completed", message: "done" },
              "failed-child": { status: "errored", message: "error" },
              "running-child": { status: "running", message: null },
            },
          },
        },
      }),
    ).toEqual(["succeeded-child", "failed-child"]);
  });

  it("recognizes a native completion receipt without treating its payload as a status", () => {
    expect(
      codexNativeSubagentNotifications.deliveredAgentPaths({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "agent_message",
            author: "/root/worker",
            recipient: "/root",
            content: [
              {
                type: "input_text",
                text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nBuild result",
              },
            ],
          },
        },
      }),
    ).toEqual(["/root/worker"]);
  });

  it.each([null, "  "])("preserves completed-without-final for %j", (completed) => {
    expect(
      extractCodexNativeSubagentCompletions({
        method: "rawResponseItem/completed",
        params: { threadId: "parent-thread", item: contextualNotificationItem({ completed }) },
      }),
    ).toEqual([
      {
        agentPath: "child-thread",
        status: "succeeded",
        statusLabel: "completed_without_final_message",
        result: "Subagent completed without a final assistant message.",
      },
    ]);
  });

  it.each([
    { nativeStatus: "shutdown", status: "cancelled" },
    { nativeStatus: "not_found", status: "failed" },
  ])("reads the native terminal unit status $nativeStatus", ({ nativeStatus, status }) => {
    expect(
      extractCodexNativeSubagentCompletions({
        method: "rawResponseItem/completed",
        params: { threadId: "parent-thread", item: contextualNotificationItem(nativeStatus) },
      }),
    ).toEqual([
      { agentPath: "child-thread", status, statusLabel: nativeStatus, result: "(no output)" },
    ]);
  });

  it.each(["pending_init", "running", "interrupted"])(
    "leaves native %s status unresolved",
    (nativeStatus) => {
      expect(
        extractCodexNativeSubagentCompletions({
          method: "rawResponseItem/completed",
          params: { threadId: "parent-thread", item: contextualNotificationItem(nativeStatus) },
        }),
      ).toEqual([]);
    },
  );

  it("reads native errors from a classified completion", () => {
    expect(
      extractCodexNativeSubagentCompletions({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          item: contextualNotificationItem({ errored: "tool failed" }),
        },
      }),
    ).toEqual([
      {
        agentPath: "child-thread",
        status: "failed",
        statusLabel: "errored",
        result: "tool failed",
      },
    ]);
  });

  it("ignores malformed classified completion payloads", () => {
    const item = contextualNotificationItem();
    item.content[0]!.text = "<subagent_notification>{not-json}</subagent_notification>";
    expect(
      extractCodexNativeSubagentCompletions({
        method: "rawResponseItem/completed",
        params: { threadId: "parent-thread", item },
      }),
    ).toEqual([]);
  });
});
