import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { sendMessageSlack } from "./send.js";

type SlackUnfurlTestClient = WebClient & {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  conversations: { open: ReturnType<typeof vi.fn> };
};

function createSlackSendTestClient(): SlackUnfurlTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as SlackUnfurlTestClient;
}

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

function missingCustomizeScopeError(): Error {
  return Object.assign(new Error("An API error occurred: missing_scope"), {
    data: {
      error: "missing_scope",
      needed: "chat:write.customize",
    },
  });
}

describe("sendMessageSlack unfurl controls", () => {
  it("omits Slack unfurl flags when config is unset", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({ botToken: "xoxb-test" }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        unfurl_links: expect.any(Boolean),
        unfurl_media: expect.any(Boolean),
      }),
    );
  });

  it("passes top-level Slack unfurl flags to chat.postMessage", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  });

  it("lets account-level Slack unfurl flags override top-level defaults", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      accountId: "work",
      cfg: slackConfig({
        botToken: "xoxb-root",
        unfurlLinks: false,
        unfurlMedia: true,
        accounts: {
          work: {
            unfurlLinks: true,
            unfurlMedia: false,
          },
        },
      }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        unfurl_links: true,
        unfurl_media: false,
      }),
    );
  });

  it("applies Slack unfurl flags to block messages", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ type: "divider" }],
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  });

  it("preserves Slack unfurl flags when custom identity falls back", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce(missingCustomizeScopeError())
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "https://example.com", {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
      identity: {
        username: "OpenClaw",
      },
    });

    expect(client.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  });

  it("applies Slack unfurl flags to every text chunk", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("channel:C123", "a".repeat(8500), {
      token: "xoxb-test",
      cfg: slackConfig({
        botToken: "xoxb-test",
        unfurlLinks: false,
        unfurlMedia: false,
      }),
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    for (const [payload] of client.chat.postMessage.mock.calls) {
      expect(payload).toEqual(
        expect.objectContaining({
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    }
  });
});
