import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import * as slackClient from "./client.js";

afterEach(() => vi.restoreAllMocks());

describe("Slack channel-create", () => {
  it("creates a public channel and returns its reusable target", async () => {
    const requests: Array<{ method: string; args: Record<string, string> }> = [];
    const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
      const url = new URL(String(input));
      if (typeof init?.body !== "string") {
        throw new Error("Expected a form-encoded Slack request body");
      }
      const args = Object.fromEntries(new URLSearchParams(init.body));
      requests.push({ method: url.pathname.split("/").at(-1) ?? "", args });
      return new Response(
        JSON.stringify({ ok: true, channel: { id: "C01234567", name: args.name } }),
        { headers: { "content-type": "application/json" } },
      );
    };
    vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
      (token, options) => new WebClient(token, { ...options, fetch, retryConfig: { retries: 0 } }),
    );
    const cfg: OpenClawConfig = {
      channels: { slack: { botToken: "xoxb-test", actions: { channels: true } } },
    };
    const adapter = createSlackActions("slack");

    const result = await adapter.handleAction!({
      channel: "slack",
      action: "channel-create",
      cfg,
      params: { name: "proj-launch-pixel-peak" },
      accountId: "default",
      requesterAccountId: "default",
      requesterSenderId: "U22222222",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "team:T11111111:channel:C09999999",
      },
    });

    expect(result.details).toEqual({
      ok: true,
      channelId: "C01234567",
      name: "proj-launch-pixel-peak",
      target: "team:T11111111:channel:C01234567",
      invitedUserId: "U22222222",
    });
    expect(requests).toEqual([
      {
        method: "conversations.create",
        args: { name: "proj-launch-pixel-peak", team_id: "T11111111" },
      },
      {
        method: "conversations.invite",
        args: { channel: "C01234567", users: "U22222222", team_id: "T11111111" },
      },
    ]);
  });

  it("returns the created channel when Slack cannot invite the requester", async () => {
    const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
      const url = new URL(String(input));
      if (typeof init?.body !== "string") {
        throw new Error("Expected a form-encoded Slack request body");
      }
      const method = url.pathname.split("/").at(-1);
      const response =
        method === "conversations.create"
          ? { ok: true, channel: { id: "C01234567", name: "proj-launch-pixel-peak" } }
          : { ok: false, error: "missing_scope" };
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    };
    vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
      (token, options) => new WebClient(token, { ...options, fetch, retryConfig: { retries: 0 } }),
    );
    const adapter = createSlackActions("slack");

    const result = await adapter.handleAction!({
      channel: "slack",
      action: "channel-create",
      cfg: { channels: { slack: { botToken: "xoxb-test", actions: { channels: true } } } },
      params: { name: "proj-launch-pixel-peak" },
      accountId: "default",
      requesterAccountId: "default",
      requesterSenderId: "U22222222",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "team:T11111111:channel:C09999999",
      },
    });

    expect(result.details).toEqual({
      ok: true,
      channelId: "C01234567",
      name: "proj-launch-pixel-peak",
      target: "team:T11111111:channel:C01234567",
      inviteWarning:
        "Slack is missing the invitation permission; the requesting user can join the returned public channel, or an operator can reauthorize the Slack app and retry.",
    });
  });

  it("does not invite the requester after caller authority closes during creation", async () => {
    const requests: string[] = [];
    let active = true;
    const assertDirectAdapterHandoff = () => {
      if (!active) {
        throw new Error("direct delivery is no longer active");
      }
    };
    const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
      assertDirectAdapterHandoff();
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      requests.push(method);
      if (method === "conversations.create") {
        active = false;
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "C01234567", name: "proj-launch-pixel-peak" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected Slack request: ${method} (${String(init?.body)})`);
    };
    vi.spyOn(slackClient, "createSlackWriteClient").mockImplementation(
      (token, options, assert) =>
        new WebClient(token, {
          ...options,
          fetch,
          retryConfig: { retries: 0 },
          ...(assert
            ? {
                fetch: async (input, init) => {
                  assert();
                  return await fetch(input, init);
                },
              }
            : {}),
        }),
    );
    const adapter = createSlackActions("slack");

    const result = await adapter.handleAction!({
      channel: "slack",
      action: "channel-create",
      cfg: { channels: { slack: { botToken: "xoxb-test", actions: { channels: true } } } },
      params: { name: "proj-launch-pixel-peak" },
      accountId: "default",
      requesterAccountId: "default",
      requesterSenderId: "U22222222",
      assertDirectAdapterHandoff,
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "team:T11111111:channel:C09999999",
      },
    });
    expect(result.details).toMatchObject({
      ok: true,
      channelId: "C01234567",
      inviteWarning:
        "Slack rejected the invitation; the requesting user can join the returned public channel, or an operator can reauthorize the Slack app and retry.",
    });
    expect(requests).toEqual(["conversations.create"]);
  });
});
