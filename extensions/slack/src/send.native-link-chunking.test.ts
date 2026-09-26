import { expect, it } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { sendMessageSlack } from "./send.js";

it.each([false, true])(
  "posts complete long native links next to prose (pre-rendered=%s)",
  async (textIsSlackMrkdwn) => {
    const client = createSlackSendTestClient();
    const prefix = "p".repeat(2_578);
    const link = `<https://example.com/chart?state=${"%2C".repeat(633)}|chart>`;

    await sendMessageSlack("channel:C123", `${prefix}${link}`, {
      cfg: { channels: { slack: { botToken: "xoxb-test", textChunkLimit: 4_000 } } },
      client,
      textIsSlackMrkdwn,
    });

    expect(client.chat.postMessage.mock.calls.map((call) => call[0].text)).toEqual([prefix, link]);
  },
);
