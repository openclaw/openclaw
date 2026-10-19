import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

// mock-isolation: exercise approval routing without initializing the live Slack sender.
vi.mock("./send.js", () => ({ sendMessageSlack: sendMessageSlackMock }));

const { slackApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
const transport = slackApprovalNativeRuntime.transport;

function pending(context: object, to = "channel:C123", teamId = "T123", surface = "origin") {
  return {
    cfg: {},
    accountId: "default",
    context,
    plannedTarget: { surface, reason: "preferred", target: { to: `team:${teamId}:${to}` } },
    preparedTarget: { to, teamId },
    pendingPayload: { text: "approve", blocks: [] },
  };
}

describe("Slack approval delivery", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset().mockResolvedValue({
      channelId: "C123",
      messageId: "1712345678.123456",
    });
  });

  it("prepares a qualified target without losing its team", async () => {
    await expect(
      slackApprovalNativeRuntime.transport.prepareTarget({
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: { to: "team:T123:channel:C123", threadId: "1712345678.000001" },
        },
      } as never),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: { to: "channel:C123", teamId: "T123", threadTs: "1712345678.000001" },
    });
  });

  it("uses the team client without requiring an Enterprise app id", async () => {
    const chatUpdate = vi.fn().mockResolvedValue({ ok: true });
    const teamClient = { chat: { update: chatUpdate }, conversations: { open: vi.fn() } };
    const resolveClient = vi.fn().mockReturnValue(teamClient);
    const context = {
      app: { client: { chat: { update: vi.fn() } } },
      config: {},
      enterprise: { enterpriseId: "E123" },
      resolveClient,
    };

    const entry = await transport.deliverPending({
      ...pending(context),
      cfg: { channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } } },
    } as never);

    expect(entry).toEqual({ channelId: "C123", messageTs: "1712345678.123456", teamId: "T123" });
    expect(resolveClient).toHaveBeenCalledWith("T123");
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:C123",
      "approve",
      expect.objectContaining({
        client: teamClient,
        eventScope: { teamId: "T123", client: teamClient },
      }),
    );

    await slackApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context,
      entry,
      payload: { text: "approved", blocks: [] },
      phase: "resolved",
    } as never);

    expect(resolveClient).toHaveBeenLastCalledWith("T123");
    expect(chatUpdate).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1712345678.123456",
      text: "approved",
      blocks: [],
    });
  });

  it.each([
    ["missing", undefined],
    ["unusable", () => undefined],
  ])("fails closed when the workspace client resolver is %s", async (_name, resolveClient) => {
    await expect(
      transport.deliverPending(
        pending({
          app: { client: {} },
          config: {},
          enterprise: { enterpriseId: "E123" },
          ...(resolveClient ? { resolveClient } : {}),
        }) as never,
      ),
    ).rejects.toThrow("Slack Enterprise Grid approval client is unavailable");
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
  });

  it("opens an approver DM with the same team client", async () => {
    const open = vi.fn().mockResolvedValue({ channel: { id: "D123" } });
    const teamClient = { chat: { update: vi.fn() }, conversations: { open } };

    await transport.deliverPending(
      pending(
        {
          app: { client: {} },
          config: {},
          enterprise: { enterpriseId: "E123" },
          resolveClient: () => teamClient,
        },
        "user:U123",
      ) as never,
    );

    expect(open).toHaveBeenCalledWith({ users: "U123", return_im: true });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:D123",
      "approve",
      expect.objectContaining({ eventScope: expect.objectContaining({ teamId: "T123" }) }),
    );
  });

  it("uses the authenticated workspace client for a reviewer DM in that workspace", async () => {
    const open = vi.fn().mockResolvedValue({ channel: { id: "D123" } });
    const client = { chat: { update: vi.fn() }, conversations: { open } };
    const context = { app: { client }, config: {}, workspaceTeamId: "T123" };

    await transport.deliverPending({
      ...pending(context, "user:U123", "T123", "approver-dm"),
      approvalKind: "exec",
    } as never);

    expect(open).toHaveBeenCalledWith({ users: "U123", return_im: true });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:D123",
      "approve",
      expect.objectContaining({ client, eventScope: expect.objectContaining({ teamId: "T123" }) }),
    );

    await expect(
      transport.deliverPending({
        ...pending(context, "user:U123", "T999", "approver-dm"),
        approvalKind: "exec",
      } as never),
    ).rejects.toThrow("Slack approval workspace does not match the authenticated installation");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
