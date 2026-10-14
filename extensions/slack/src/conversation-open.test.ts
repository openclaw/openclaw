import { WebClient, type WebClientOptions } from "@slack/web-api";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import * as slackClient from "./client.js";

type SlackRequest = {
  method: string;
  args: Record<string, string>;
  authorization: string | null;
};

function createConversationFixture(
  conversationId = "C01234567",
  openResponse?: Record<string, unknown>,
) {
  const requests: SlackRequest[] = [];
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        userToken: "xoxp-readonly",
        userTokenReadOnly: true,
      },
    },
  };
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const url = new URL(String(input));
    if (typeof init?.body !== "string") {
      throw new Error("Expected a form-encoded Slack request body");
    }
    const args = Object.fromEntries(new URLSearchParams(init.body));
    const method = url.pathname.split("/").at(-1) ?? "";
    requests.push({ method, args, authorization: new Headers(init?.headers).get("authorization") });
    const response =
      method === "conversations.open"
        ? (openResponse ?? { ok: true, channel: { id: conversationId } })
        : method === "chat.postMessage"
          ? { ok: true, channel: args.channel, ts: "171234.567", message: { text: args.text } }
          : undefined;
    if (!response) {
      throw new Error(`Unexpected Slack request: ${method}`);
    }
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  };
  vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
    (token, options) => new WebClient(token, { ...options, fetch, retryConfig: { retries: 0 } }),
  );
  vi.spyOn(slackClient, "createSlackLookupClient").mockImplementation(() => {
    throw new Error("Opening and sending must not use the read client");
  });
  const adapter = createSlackActions("slack");
  const invoke = (
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    overrides: Partial<ChannelMessageActionContext> = {},
  ) =>
    adapter.handleAction!({
      channel: "slack",
      action,
      cfg,
      params,
      accountId: "default",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "team:T11111111:channel:C09999999",
        currentThreadTs: "170000.111",
        replyToMode: "all",
      },
      ...overrides,
    });
  return { adapter, cfg, invoke, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Slack conversation-open", () => {
  it("exposes the recipient contract to the message tool", () => {
    const { adapter, cfg } = createConversationFixture();
    const discovery = adapter.describeMessageTool({ cfg, accountId: "default" });
    expect(discovery?.actions).toContain("conversation-open");
    const contributions = discovery?.schema;
    const schema = (Array.isArray(contributions) ? contributions : [contributions]).find((entry) =>
      entry?.actions?.includes("conversation-open"),
    );
    expect(schema?.properties.userIds).toMatchObject({ type: "array", minItems: 1, maxItems: 8 });
    expect(schema?.properties).not.toHaveProperty("teamId");
  });

  it("opens one group DM and sends to its returned target as the bot", async () => {
    const channelId = "C01234567";
    const { cfg, invoke, requests } = createConversationFixture(channelId);
    cfg.channels!.slack!.dm = { groupEnabled: false, groupChannels: ["G99999999"] };
    const policy = structuredClone(cfg);
    const opened = await invoke("conversation-open", { userIds: ["U11111111", "U22222222"] });
    const target = `team:T11111111:channel:${channelId}`;
    expect(opened.details).toEqual({ ok: true, channelId, target });
    expect(requests).toEqual([
      {
        method: "conversations.open",
        args: { users: "U11111111,U22222222", team_id: "T11111111" },
        authorization: "Bearer xoxb-test",
      },
    ]);

    await invoke("send", { to: target, message: "Hello together" });
    expect(requests.map((request) => request.method)).toEqual([
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(requests[1]).toMatchObject({
      authorization: "Bearer xoxb-test",
      args: { channel: channelId, text: "Hello together", team_id: "T11111111" },
    });
    expect(requests[1]?.args).not.toHaveProperty("thread_ts");
    expect(cfg).toEqual(policy);
  });

  it("opens a one-to-one DM without requiring a current conversation", async () => {
    const { invoke, requests } = createConversationFixture("D01234567");
    const opened = await invoke(
      "conversation-open",
      { userIds: ["U11111111"] },
      { toolContext: undefined },
    );
    expect(opened.details).toEqual({
      ok: true,
      channelId: "D01234567",
      target: "channel:D01234567",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual({ users: "U11111111" });
  });

  it("rejects duplicates after trimming before calling Slack", async () => {
    const { invoke, requests } = createConversationFixture();
    await expect(
      invoke("conversation-open", { userIds: ["U11111111", " U11111111 "] }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("honors the messages action gate in discovery and execution", async () => {
    const { adapter, cfg, invoke, requests } = createConversationFixture();
    cfg.channels!.slack!.actions = { messages: false };
    expect(adapter.describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain(
      "conversation-open",
    );
    await expect(
      invoke("conversation-open", { userIds: ["U11111111", "U22222222"] }),
    ).rejects.toThrow("Slack messages are disabled");
    expect(requests).toEqual([]);
  });

  it("does not fall back to a user read token when the bot token is missing", async () => {
    const { adapter, cfg, invoke, requests } = createConversationFixture();
    vi.stubEnv("SLACK_BOT_TOKEN", undefined);
    cfg.channels!.slack!.botToken = undefined;
    expect(adapter.describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain(
      "conversation-open",
    );
    await expect(invoke("conversation-open", { userIds: ["U11111111"] })).rejects.toThrow(
      "botToken is required",
    );
    expect(requests).toEqual([]);
  });

  it("rejects an invalid Slack conversation ID without sending a message", async () => {
    const response = { ok: true, channel: { id: "U11111111" } };
    const { invoke, requests } = createConversationFixture("C01234567", response);
    await expect(
      invoke("conversation-open", { userIds: ["U11111111", "U22222222"] }),
    ).rejects.toThrow("valid conversation ID");
    expect(requests.map((request) => request.method)).toEqual(["conversations.open"]);
  });
});
