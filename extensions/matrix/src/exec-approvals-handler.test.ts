import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixExecApprovalHandler } from "./exec-approvals-handler.js";

const baseRequest = {
  id: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
  request: {
    command: "npm view diver name version description",
    agentId: "main",
    sessionKey: "agent:main:matrix:channel:!ops:example.org",
    turnSourceChannel: "matrix",
    turnSourceTo: "room:!ops:example.org",
    turnSourceThreadId: "$thread",
    turnSourceAccountId: "default",
  },
  createdAtMs: 1000,
  expiresAtMs: 61_000,
};

function createHandler(cfg: OpenClawConfig, accountId = "default") {
  const client = {} as never;
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "$m1", roomId: "!ops:example.org" })
    .mockResolvedValue({ messageId: "$m2", roomId: "!dm-owner:example.org" });
  const editMessage = vi.fn().mockResolvedValue({ eventId: "$edit1" });
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const repairDirectRooms = vi.fn().mockResolvedValue({
    activeRoomId: "!dm-owner:example.org",
  });
  const handler = new MatrixExecApprovalHandler(
    {
      client,
      accountId,
      cfg,
    },
    {
      nowMs: () => 1000,
      sendMessage,
      editMessage,
      deleteMessage,
      repairDirectRooms,
    },
  );
  return { client, handler, sendMessage, editMessage, deleteMessage, repairDirectRooms };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MatrixExecApprovalHandler", () => {
  it("sends approval prompts to the originating matrix room when target=channel", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested(baseRequest);

    expect(sendMessage).toHaveBeenCalledWith(
      "room:!ops:example.org",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
        threadId: "$thread",
      }),
    );
  });

  it("falls back to approver dms when channel routing is unavailable", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { client, handler, sendMessage, repairDirectRooms } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C1",
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
    });

    expect(repairDirectRooms).toHaveBeenCalledWith({
      client,
      remoteUserId: "@owner:example.org",
      encrypted: false,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "room:!dm-owner:example.org",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("does not send foreign-channel approvals from unbound multi-account matrix configs", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot-default:example.org",
              accessToken: "tok-default",
              execApprovals: {
                enabled: true,
                approvers: ["@owner:example.org"],
                target: "channel",
              },
            },
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@bot-ops:example.org",
              accessToken: "tok-ops",
              execApprovals: {
                enabled: true,
                approvers: ["@owner:example.org"],
                target: "channel",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const defaultHandler = createHandler(cfg, "default");
    const opsHandler = createHandler(cfg, "ops");
    const request = {
      ...baseRequest,
      request: {
        ...baseRequest.request,
        sessionKey: "agent:main:missing",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C1",
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
    };

    await defaultHandler.handler.handleRequested(request);
    await opsHandler.handler.handleRequested(request);

    expect(defaultHandler.sendMessage).not.toHaveBeenCalled();
    expect(opsHandler.sendMessage).not.toHaveBeenCalled();
    expect(defaultHandler.repairDirectRooms).not.toHaveBeenCalled();
    expect(opsHandler.repairDirectRooms).not.toHaveBeenCalled();
  });

  it("does not double-send when the origin room is the approver dm", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "dm",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        sessionKey: "agent:main:matrix:direct:!dm-owner:example.org",
        turnSourceTo: "room:!dm-owner:example.org",
        turnSourceThreadId: undefined,
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "room:!dm-owner:example.org",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("edits tracked approval messages when resolved", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "both",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, editMessage } = createHandler(cfg);

    await handler.handleRequested(baseRequest);
    await handler.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "matrix:@owner:example.org",
      ts: 2000,
    });

    expect(editMessage).toHaveBeenCalledWith(
      "!ops:example.org",
      "$m1",
      expect.stringContaining("Exec approval: Allowed once"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("deletes tracked approval messages when they expire", async () => {
    vi.useFakeTimers();
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "both",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, deleteMessage } = createHandler(cfg);

    await handler.handleRequested(baseRequest);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deleteMessage).toHaveBeenCalledWith(
      "!ops:example.org",
      "$m1",
      expect.objectContaining({
        accountId: "default",
        reason: "approval expired",
      }),
    );
  });

  it("honors request decision constraints in pending approval text", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
          execApprovals: {
            enabled: true,
            approvers: ["@owner:example.org"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        ask: "always",
        allowedDecisions: ["allow-once", "deny"],
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "room:!ops:example.org",
      expect.not.stringContaining("allow-always"),
      expect.anything(),
    );
  });
});
