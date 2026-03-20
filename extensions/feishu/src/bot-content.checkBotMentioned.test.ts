import { describe, expect, it } from "vitest";
import { checkBotMentioned } from "./bot-content.js";

function makeEvent(
  content: string,
  mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>,
  messageType = "text",
) {
  return {
    message: {
      content,
      message_type: messageType,
      mentions,
      chat_id: "oc_group",
      message_id: "om_test",
    },
    sender: {
      sender_id: { open_id: "ou_sender" },
    },
  };
}

describe("checkBotMentioned", () => {
  const botId = "ou_bot_123";

  it("returns true when bot is explicitly mentioned", () => {
    const event = makeEvent('{"text":"@_user_1 hello"}', [
      { key: "@_user_1", id: { open_id: botId }, name: "Bot" },
    ]);
    expect(checkBotMentioned(event, botId)).toBe(true);
  });

  it("returns false when a different user is mentioned", () => {
    const event = makeEvent('{"text":"@_user_1 hello"}', [
      { key: "@_user_1", id: { open_id: "ou_other" }, name: "Other" },
    ]);
    expect(checkBotMentioned(event, botId)).toBe(false);
  });

  it("returns false when @_all is the only mention (#49761)", () => {
    const event = makeEvent('{"text":"@_all hello everyone"}', [
      { key: "@_all", id: { open_id: botId }, name: "所有人" },
    ]);
    expect(checkBotMentioned(event, botId)).toBe(false);
  });

  it("returns true when bot is mentioned alongside @_all", () => {
    const event = makeEvent('{"text":"@_all @_user_1 hello"}', [
      { key: "@_all", id: { open_id: botId }, name: "所有人" },
      { key: "@_user_1", id: { open_id: botId }, name: "Bot" },
    ]);
    expect(checkBotMentioned(event, botId)).toBe(true);
  });

  it("returns false when no mentions and no bot open id in content", () => {
    const event = makeEvent('{"text":"hello world"}');
    expect(checkBotMentioned(event, botId)).toBe(false);
  });

  it("returns false when botOpenId is undefined", () => {
    const event = makeEvent('{"text":"@_user_1 hello"}', [
      { key: "@_user_1", id: { open_id: "ou_bot_123" }, name: "Bot" },
    ]);
    expect(checkBotMentioned(event, undefined)).toBe(false);
  });
});
