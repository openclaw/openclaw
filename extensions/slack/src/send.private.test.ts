import { describe, expect, it } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { sendMessageSlack } from "./send.js";

describe("Slack sensitive private sends", () => {
  const cfg = { channels: { slack: { botToken: "xoxb-test" } } };

  it("preserves the sign-in URL without previews or a public thread target", async () => {
    const client = createSlackSendTestClient();
    const text = "Connect: https://example.test/authorize?state=private-fixture&scope=read";
    await sendMessageSlack("user:U123", text, {
      cfg,
      token: "xoxb-test",
      client,
      textIsSlackPlainText: true,
      suppressLinkPreviews: true,
    });

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "U123",
      text,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("does not post when authority closes during awaited delivery preparation", async () => {
    const client = createSlackSendTestClient();
    let active = true;
    await expect(
      sendMessageSlack("user:U123", "private", {
        cfg,
        token: "xoxb-test",
        client,
        onPlatformSendDispatch: async () => {
          active = false;
        },
        assertPlatformSendAuthorized: () => {
          if (!active) {
            throw new Error("Run closed");
          }
        },
      }),
    ).rejects.toThrow("Run closed");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rechecks authority before later chunks after the first acknowledged post", async () => {
    const client = createSlackSendTestClient();
    let active = true;
    client.chat.postMessage.mockImplementation(async () => {
      active = false;
      return { ts: "171234.567" };
    });
    await expect(
      sendMessageSlack("user:U123", "private ".repeat(1100), {
        cfg,
        token: "xoxb-test",
        client,
        assertPlatformSendAuthorized: () => {
          if (!active) {
            throw new Error("Run closed");
          }
        },
      }),
    ).rejects.toThrow("Run closed");
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
  });
});
