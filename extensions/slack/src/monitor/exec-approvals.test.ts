import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

let SlackExecApprovalHandler: typeof import("./exec-approvals.js").SlackExecApprovalHandler;

function buildConfig(target: "dm" | "channel" | "both" = "dm"): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        execApprovals: {
          enabled: true,
          approvers: ["U123APPROVER"],
          target,
        },
      },
    },
  } as OpenClawConfig;
}

function buildApp(): App {
  return {
    client: {
      chat: {
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as App;
}

function buildRequest(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "req-1",
    request: {
      command: "python3 -c \"print('slack exec approval smoke')\"",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123ROOM",
      turnSourceAccountId: "default",
      turnSourceThreadId: "1712345678.123456",
      sessionKey: "agent:main:slack:channel:c123room:thread:1712345678.123456",
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: Date.now() + 60_000,
  };
}

describe("SlackExecApprovalHandler", () => {
  beforeAll(async () => {
    ({ SlackExecApprovalHandler } = await import("./exec-approvals.js"));
  });

  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    sendMessageSlackMock.mockResolvedValue({
      messageId: "1712345678.999999",
      channelId: "D123APPROVER",
    });
  });

  it("delivers DM-first approvals and only posts a short origin notice", async () => {
    const app = buildApp();
    const handler = new SlackExecApprovalHandler({
      app,
      accountId: "default",
      config: buildConfig("dm").channels!.slack!.execApprovals!,
      cfg: buildConfig("dm"),
    });

    await handler.handleApprovalRequested(buildRequest());

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(2);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      1,
      "channel:C123ROOM",
      "Approval required. I sent approval DMs to the approvers for this account.",
      expect.objectContaining({
        accountId: "default",
        threadTs: "1712345678.123456",
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(
      2,
      "user:U123APPROVER",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({
        accountId: "default",
        blocks: expect.arrayContaining([expect.objectContaining({ type: "actions" })]),
      }),
    );
  });

  it("does not post a redundant DM redirect notice when the origin is already the approver DM", async () => {
    const app = buildApp();
    const handler = new SlackExecApprovalHandler({
      app,
      accountId: "default",
      config: buildConfig("dm").channels!.slack!.execApprovals!,
      cfg: buildConfig("dm"),
    });

    await handler.handleApprovalRequested(
      buildRequest({
        turnSourceTo: "user:U123APPROVER",
        turnSourceThreadId: undefined,
        sessionKey: "agent:main:slack:direct:U123APPROVER",
      }),
    );

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "user:U123APPROVER",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({
        blocks: expect.arrayContaining([expect.objectContaining({ type: "actions" })]),
      }),
    );
  });

  it("updates the pending approval card in place after resolution", async () => {
    const app = buildApp();
    const update = app.client.chat.update as ReturnType<typeof vi.fn>;
    const handler = new SlackExecApprovalHandler({
      app,
      accountId: "default",
      config: buildConfig("dm").channels!.slack!.execApprovals!,
      cfg: buildConfig("dm"),
    });

    await handler.handleApprovalRequested(
      buildRequest({
        turnSourceTo: "user:U123APPROVER",
        turnSourceThreadId: undefined,
        sessionKey: "agent:main:slack:direct:U123APPROVER",
      }),
    );
    await handler.handleApprovalResolved({
      id: "req-1",
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
      request: buildRequest().request,
      ts: Date.now(),
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123APPROVER",
        ts: "1712345678.999999",
        text: expect.stringContaining("Exec approval: Allowed once"),
        blocks: expect.not.arrayContaining([expect.objectContaining({ type: "actions" })]),
      }),
    );
  });
});
