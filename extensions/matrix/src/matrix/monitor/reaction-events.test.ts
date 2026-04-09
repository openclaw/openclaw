import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMatrixApprovalReactionTargetsForTest,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import type { CoreConfig } from "../../types.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";

const resolveMatrixExecApproval = vi.fn();

vi.mock("../../exec-approval-resolver.js", () => ({
  isApprovalNotFoundError: (err: unknown) =>
    err instanceof Error && /unknown or expired approval id/i.test(err.message),
  resolveMatrixExecApproval: (...args: unknown[]) => resolveMatrixExecApproval(...args),
}));

beforeEach(() => {
  resolveMatrixExecApproval.mockReset();
  clearMatrixApprovalReactionTargetsForTest();
});

function buildConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        reactionNotifications: "own",
        execApprovals: {
          enabled: true,
          approvers: ["@owner:example.org"],
          target: "channel",
        },
      },
    },
  } as CoreConfig;
}

function buildCore() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
          mainSessionKey: "agent:main:matrix:channel:!ops:example.org",
          agentId: "main",
          matchedBy: "peer",
        }),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["core"];
}

describe("matrix approval reactions", () => {
  it("resolves approval reactions instead of enqueueing a generic reaction event", async () => {
    const core = buildCore();
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        event_id: "$approval-msg",
        sender: "@bot:example.org",
        content: { body: "approval prompt" },
      }),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg: buildConfig(),
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$approval-msg",
            key: "✅",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(resolveMatrixExecApproval).toHaveBeenCalledWith({
      cfg: buildConfig(),
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps ordinary reactions on bot messages as generic reaction events", async () => {
    const core = buildCore();
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        event_id: "$msg-1",
        sender: "@bot:example.org",
        content: {
          body: "normal bot message",
        },
      }),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg: buildConfig(),
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$msg-1",
            key: "👍",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(resolveMatrixExecApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by Owner on msg $msg-1",
      expect.objectContaining({
        contextKey: "matrix:reaction:add:!ops:example.org:$msg-1:@owner:example.org:👍",
      }),
    );
  });

  it("still resolves approval reactions when generic reaction notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["deny"],
    });
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        event_id: "$approval-msg",
        sender: "@bot:example.org",
        content: { body: "approval prompt" },
      }),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg,
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$approval-msg",
            key: "❌",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(resolveMatrixExecApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "req-123",
      decision: "deny",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("resolves registered approval reactions without fetching the target event", async () => {
    const core = buildCore();
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once"],
    });
    const client = {
      getEvent: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg: buildConfig(),
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$approval-msg",
            key: "✅",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixExecApproval).toHaveBeenCalledWith({
      cfg: buildConfig(),
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("unregisters stale approval anchors after not-found resolution", async () => {
    const core = buildCore();
    resolveMatrixExecApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id req-123"),
    );
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["deny"],
    });
    const client = {
      getEvent: vi.fn(),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg: buildConfig(),
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$approval-msg",
            key: "❌",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "❌",
      }),
    ).toBeNull();
  });

  it("skips target fetches for ordinary reactions when notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    const client = {
      getEvent: vi.fn(),
    } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["client"];

    await handleInboundMatrixReaction({
      client,
      core,
      cfg,
      accountId: "default",
      roomId: "!ops:example.org",
      event: {
        event_id: "$reaction-1",
        origin_server_ts: 123,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$msg-1",
            key: "👍",
          },
        },
      } as never,
      senderId: "@owner:example.org",
      senderLabel: "Owner",
      selfUserId: "@bot:example.org",
      isDirectMessage: false,
      logVerboseMessage: vi.fn(),
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixExecApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
