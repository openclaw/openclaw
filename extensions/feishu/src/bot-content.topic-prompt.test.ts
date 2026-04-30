import { describe, expect, it } from "vitest";
import { buildFeishuGroupTopicPromptHint, isFeishuTopicGroupSessionScope } from "./bot-content.js";

describe("isFeishuTopicGroupSessionScope", () => {
  it("returns true for group_topic and group_topic_sender", () => {
    expect(isFeishuTopicGroupSessionScope("group_topic")).toBe(true);
    expect(isFeishuTopicGroupSessionScope("group_topic_sender")).toBe(true);
  });

  it("returns false for non-topic scopes and undefined", () => {
    expect(isFeishuTopicGroupSessionScope("group")).toBe(false);
    expect(isFeishuTopicGroupSessionScope("group_sender")).toBe(false);
    expect(isFeishuTopicGroupSessionScope(undefined)).toBe(false);
  });
});

describe("buildFeishuGroupTopicPromptHint", () => {
  it("emits a thread-reply hint for group_topic with a root message id", () => {
    const hint = buildFeishuGroupTopicPromptHint({
      groupSessionScope: "group_topic",
      topicRootMessageId: "om_root_42",
    });
    expect(hint).toBeDefined();
    expect(hint).toContain("groupSessionScope=group_topic");
    expect(hint).toContain('action="thread-reply"');
    expect(hint).toContain('messageId="om_root_42"');
    expect(hint).toContain('action="send"');
  });

  it("emits a hint for group_topic_sender", () => {
    const hint = buildFeishuGroupTopicPromptHint({
      groupSessionScope: "group_topic_sender",
      topicRootMessageId: "om_root_99",
    });
    expect(hint).toContain("groupSessionScope=group_topic_sender");
    expect(hint).toContain('messageId="om_root_99"');
  });

  it("returns undefined for non-topic group scopes", () => {
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: "group",
        topicRootMessageId: "om_root_1",
      }),
    ).toBeUndefined();
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: "group_sender",
        topicRootMessageId: "om_root_1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when scope is undefined", () => {
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: undefined,
        topicRootMessageId: "om_root_1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when topic root message id is missing or blank", () => {
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: "group_topic",
        topicRootMessageId: undefined,
      }),
    ).toBeUndefined();
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: "group_topic",
        topicRootMessageId: null,
      }),
    ).toBeUndefined();
    expect(
      buildFeishuGroupTopicPromptHint({
        groupSessionScope: "group_topic",
        topicRootMessageId: "   ",
      }),
    ).toBeUndefined();
  });

  it("trims whitespace around the topic root message id", () => {
    const hint = buildFeishuGroupTopicPromptHint({
      groupSessionScope: "group_topic",
      topicRootMessageId: "  om_root_77  ",
    });
    expect(hint).toContain('messageId="om_root_77"');
  });
});
