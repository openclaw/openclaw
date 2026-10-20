import { WebClient, type WebClientOptions } from "@slack/web-api";
import type {
  ChannelMessageActionContext as Context,
  ChannelMessageActionName as Action,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import * as slackClient from "./client.js";

const credentials = { botToken: "xoxb-test", userToken: "xoxp-readonly", userTokenReadOnly: true };

function createFixture(id = "C01234567", openResponse?: Record<string, unknown>) {
  const requests: { method: string; args: Record<string, string>; authorization: string | null }[] =
    [];
  const cfg: OpenClawConfig = { channels: { slack: { ...credentials } } };
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a form-encoded Slack request body");
    }
    const args = Object.fromEntries(new URLSearchParams(init.body));
    const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    requests.push({ method, args, authorization: new Headers(init?.headers).get("authorization") });
    const response =
      method === "conversations.open"
        ? (openResponse ?? { ok: true, channel: { id } })
        : method === "chat.postMessage"
          ? { ok: true, channel: args.channel, ts: "171234.567", message: { text: args.text } }
          : undefined;
    if (!response) {
      throw new Error(`Unexpected Slack request: ${method}`);
    }
    return Response.json(response);
  };
  vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
    (token, options) => new WebClient(token, { ...options, fetch, retryConfig: { retries: 0 } }),
  );
  vi.spyOn(slackClient, "createSlackLookupClient").mockImplementation(() => {
    throw new Error("Opening and sending must not use the read client");
  });
  const adapter = createSlackActions("slack");
  const invoke = (action: Action, params: Context["params"], overrides: Partial<Context> = {}) =>
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
  const open = (userIds = ["U11111111", "U22222222"], overrides: Partial<Context> = {}) =>
    invoke("conversation-open", { userIds }, overrides);
  const discover = () => adapter.describeMessageTool({ cfg, accountId: "default" });
  return { cfg, invoke, open, discover, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("exposes the recipient contract to the message tool", () => {
  const { discover } = createFixture();
  const discovery = discover();
  expect(discovery?.actions).toContain("conversation-open");
  const schema = [discovery?.schema]
    .flat()
    .find((entry) => entry?.actions?.includes("conversation-open"));
  expect(schema?.properties.userIds).toMatchObject({ type: "array", minItems: 1, maxItems: 8 });
  expect(schema?.properties).not.toHaveProperty("teamId");
});

it.each([true, false])("opens a bot DM with workspace context=%s", async (group) => {
  const channelId = group ? "C01234567" : "D01234567";
  const { cfg, invoke, open, requests } = createFixture(channelId);
  if (group) {
    cfg.channels!.slack!.dm = { groupEnabled: false, groupChannels: ["G99999999"] };
  }
  const policy = structuredClone(cfg);
  const target = group ? `team:T11111111:channel:${channelId}` : `channel:${channelId}`;
  const overrides = group ? {} : { toolContext: undefined };
  const opened = await open(group ? undefined : ["U11111111"], overrides);
  expect(opened.details).toEqual({ ok: true, channelId, target });
  expect(requests).toEqual([
    {
      method: "conversations.open",
      args: group ? { users: "U11111111,U22222222", team_id: "T11111111" } : { users: "U11111111" },
      authorization: "Bearer xoxb-test",
    },
  ]);

  if (group) {
    await invoke("send", { to: target, message: "Hello together" });
    expect(requests.slice(1)).toMatchObject([
      {
        method: "chat.postMessage",
        authorization: "Bearer xoxb-test",
        args: { channel: channelId, text: "Hello together", team_id: "T11111111" },
      },
    ]);
    expect(requests[1]?.args).not.toHaveProperty("thread_ts");
  }
  expect(cfg).toEqual(policy);
});

it("rejects duplicates after trimming before calling Slack", async () => {
  const { open, requests } = createFixture();
  await expect(open(["U11111111", " U11111111 "])).rejects.toThrow();
  expect(requests).toEqual([]);
});

it.each([
  ["messages disabled", { actions: { messages: false } }, "Slack messages are disabled", false],
  ["bot token missing", { botToken: undefined }, "botToken is required", true],
] as const)("rejects discovery and execution with %s", async (_name, patch, error, single) => {
  const { cfg, open, discover, requests } = createFixture();
  vi.stubEnv("SLACK_BOT_TOKEN", undefined);
  Object.assign(cfg.channels!.slack!, patch);
  expect(discover()?.actions).not.toContain("conversation-open");
  await expect(open(single ? ["U11111111"] : undefined)).rejects.toThrow(error);
  expect(requests).toEqual([]);
});

it("rejects an invalid Slack conversation ID without sending a message", async () => {
  const response = { ok: true, channel: { id: "U11111111" } };
  const { open, requests } = createFixture("C01234567", response);
  await expect(open()).rejects.toThrow("valid conversation ID");
  expect(requests.map((request) => request.method)).toEqual(["conversations.open"]);
});
