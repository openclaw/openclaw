import { describe, expect, it } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const SLACK_TEXT_LIMIT = 8000;

describe("sendMessageSlack grapheme chunking", () => {
  it("keeps a family emoji whole in plain-text fallback posts", async () => {
    const client = createSlackSendTestClient();
    const family = "👨‍👩‍👧‍👦";
    const prefix = "a".repeat(SLACK_TEXT_LIMIT - 2);

    await sendMessageSlack("channel:C123", `${prefix}${family}Z`, {
      cfg: SLACK_TEST_CFG,
      client,
      textIsSlackPlainText: true,
    });

    const postedTexts = client.chat.postMessage.mock.calls.map((call) => call[0].text);
    expect(postedTexts).toEqual([prefix, `${family}Z`]);
    expect(
      postedTexts.every((text) => typeof text === "string" && text.length <= SLACK_TEXT_LIMIT),
    ).toBe(true);
  });
});
