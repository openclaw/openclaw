import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerMatrixApprovalReactionTarget as registerTargetRaw,
  resolveMatrixApprovalReactionTargetWithPersistence as resolveTargetRaw,
  unregisterMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import type { CoreConfig } from "../../types.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";

type RegisterTargetParams = Parameters<typeof registerTargetRaw>[0];
const touchedTargets = new Map<
  string,
  Parameters<typeof unregisterMatrixApprovalReactionTarget>[0]
>();

const defaultApprovalTarget: RegisterTargetParams = {
  accountId: "default",
  roomId: "!ops:example.org",
  eventId: "$approval-msg",
  approvalId: "req-123",
  approvalKind: "exec",
  allowedDecisions: ["allow-once", "deny"],
};

async function registerTarget(params: Partial<RegisterTargetParams>): Promise<void> {
  const { accountId, ...target } = { ...defaultApprovalTarget, ...params };
  const targetRef = { accountId, roomId: target.roomId, eventId: target.eventId };
  touchedTargets.set(JSON.stringify(targetRef), targetRef);
  await registerTargetRaw({ ...target, accountId });
}

const resolveMatrixApproval = vi.fn();
const editMessageMatrix = vi.fn();
type MatrixReactionParams = Parameters<typeof handleInboundMatrixReaction>[0];
type MatrixReactionClient = MatrixReactionParams["client"];

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) => resolveMatrixApproval(...args),
}));

vi.mock("../send.js", () => ({
  editMessageMatrix: (...args: unknown[]) => editMessageMatrix(...args),
}));

beforeEach(() => {
  resetSystemEventsForTest();
  resolveMatrixApproval.mockReset().mockResolvedValue({
    applied: true,
    approval: { id: "req-123", status: "allowed", decision: "allow-once" },
  });
  editMessageMatrix.mockReset().mockResolvedValue("$edit");
});

afterEach(async () => {
  resetSystemEventsForTest();
  for (const target of touchedTargets.values()) {
    await unregisterMatrixApprovalReactionTarget(target);
  }
  touchedTargets.clear();
});

function buildConfig(
  overrides: Partial<NonNullable<CoreConfig["channels"]>["matrix"]> = {},
): CoreConfig {
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
        ...overrides,
      },
    },
  } as CoreConfig;
}

function buildCore() {
  return {
    system: { enqueueSystemEvent },
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
  } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["core"];
}

function createReactionClient(
  getEvent: ReturnType<typeof vi.fn> = vi.fn(),
): MatrixReactionClient & { getEvent: ReturnType<typeof vi.fn> } {
  return { getEvent } as unknown as MatrixReactionClient & {
    getEvent: ReturnType<typeof vi.fn>;
  };
}

async function handleReaction(
  params: {
    client?: MatrixReactionClient;
    cfg?: CoreConfig;
    targetEventId?: string;
    reactionKey?: string;
    logVerboseMessage?: (message: string) => void;
  } = {},
): Promise<void> {
  await handleInboundMatrixReaction({
    client: params.client ?? createReactionClient(),
    core: buildCore(),
    cfg: params.cfg ?? buildConfig(),
    accountId: "default",
    roomId: "!ops:example.org",
    event: {
      event_id: "$reaction-1",
      sender: "@owner:example.org",
      type: "m.reaction",
      origin_server_ts: 123,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: params.targetEventId ?? "$approval-msg",
          key: params.reactionKey ?? "✅",
        },
      },
    },
    senderId: "@owner:example.org",
    senderLabel: "Owner",
    selfUserId: "@bot:example.org",
    isDirectMessage: false,
    logVerboseMessage: params.logVerboseMessage ?? vi.fn<(message: string) => void>(),
  });
}

function resolveTarget(
  reactionKey: string,
  roomId = "!ops:example.org",
  eventId = "$approval-msg",
) {
  return resolveTargetRaw({ accountId: "default", roomId, eventId, reactionKey });
}
function systemEvents() {
  return peekSystemEventEntries("agent:main:matrix:channel:!ops:example.org");
}
function approvalCall(
  cfg: CoreConfig,
  overrides: Partial<{
    approvalId: string;
    approvalKind: string;
    decision: string;
  }> = {},
) {
  return {
    cfg,
    approvalId: "req-123",
    approvalKind: "exec",
    decision: "allow-once",
    channel: "matrix",
    accountId: "default",
    senderId: "@owner:example.org",
    ...overrides,
  };
}
describe("matrix approval reactions", () => {
  it("keeps ordinary reactions on bot messages as generic reaction events", async () => {
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        event_id: "$msg-1",
        sender: "@bot:example.org",
        content: {
          body: "normal bot message",
        },
      }),
    );
    await handleReaction({
      client,
      targetEventId: "$msg-1",
      reactionKey: "👍",
    });
    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(systemEvents()).toEqual([
      expect.objectContaining({
        text: "Matrix reaction added: 👍 by Owner on msg $msg-1",
        contextKey: "matrix:reaction:add:!ops:example.org:$msg-1:@owner:example.org:👍",
      }),
    ]);
  });

  it("still resolves approval reactions when generic reaction notifications are off", async () => {
    const cfg = buildConfig({ reactionNotifications: "off" });
    await registerTarget({ allowedDecisions: ["deny"] });
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        event_id: "$approval-msg",
        sender: "@bot:example.org",
        content: { body: "approval prompt" },
      }),
    );
    await handleReaction({ client, cfg, reactionKey: "❌" });
    expect(resolveMatrixApproval).toHaveBeenCalledWith(approvalCall(cfg, { decision: "deny" }));
    expect(systemEvents()).toEqual([]);
  });

  it("resolves plugin approval reactions through the same Matrix reaction path", async () => {
    const cfg = buildConfig({ dm: { allowFrom: ["@owner:example.org"] } });
    await registerTarget({
      eventId: "$plugin-approval-msg",
      approvalId: "plugin:req-123",
      approvalKind: "plugin",
    });
    const client = createReactionClient();
    await handleReaction({ client, cfg, targetEventId: "$plugin-approval-msg" });
    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).toHaveBeenCalledWith(
      approvalCall(cfg, { approvalId: "plugin:req-123", approvalKind: "plugin" }),
    );
    expect(systemEvents()).toEqual([]);
  });

  it("unregisters stale approval anchors after not-found resolution", async () => {
    resolveMatrixApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id req-123"),
    );
    await registerTarget({ allowedDecisions: ["deny"] });
    const client = createReactionClient();
    await handleReaction({ client, reactionKey: "❌" });
    expect(client.getEvent).not.toHaveBeenCalled();
    expect(await resolveTarget("❌")).toBeNull();
  });

  it("retains approval anchors and propagates transient Gateway failures for replay", async () => {
    const cfg = buildConfig();
    await registerTarget({ allowedDecisions: ["allow-once"] });
    const client = createReactionClient();
    resolveMatrixApproval.mockRejectedValueOnce(new Error("gateway 503"));
    await expect(handleReaction({ client, cfg })).rejects.toThrow("gateway 503");
    expect(await resolveTarget("✅")).not.toBeNull();
    await handleReaction({ client, cfg });
    expect(await resolveTarget("✅")).toBeNull();
    expect(resolveMatrixApproval).toHaveBeenCalledTimes(2);
    expect(resolveMatrixApproval).toHaveBeenLastCalledWith(approvalCall(cfg));
    expect(systemEvents()).toEqual([]);
  });

  it("unregisters losing surfaces and reports the canonical terminal decision", async () => {
    const cfg = buildConfig();
    const logVerboseMessage = vi.fn();
    resolveMatrixApproval.mockResolvedValueOnce({
      applied: false,
      approval: { id: "req-123", status: "denied", decision: "deny" },
    });
    await registerTarget({});
    await registerTarget({ roomId: "!approvals:example.org", eventId: "$approval-dm" });
    const client = createReactionClient();
    await handleReaction({ client, cfg, reactionKey: "✅", logVerboseMessage });
    expect(await resolveTarget("✅")).toBeNull();
    expect(await resolveTarget("✅", "!approvals:example.org", "$approval-dm")).toBeNull();
    expect(editMessageMatrix).toHaveBeenCalledTimes(2);
    for (const [room, event] of [
      ["!ops:example.org", "$approval-msg"],
      ["!approvals:example.org", "$approval-dm"],
    ]) {
      expect(editMessageMatrix).toHaveBeenCalledWith(
        room,
        event,
        "Already resolved: Denied\n\nID: req-123",
        { cfg, accountId: "default", client },
      );
    }
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: approval reaction resolved id=req-123 sender=@owner:example.org applied=false status=denied decision=deny",
    );
  });

  it("skips target fetches for ordinary reactions when notifications are off", async () => {
    const cfg = buildConfig({ reactionNotifications: "off" });
    const client = createReactionClient();
    await handleReaction({ client, cfg, targetEventId: "$msg-1", reactionKey: "👍" });
    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(systemEvents()).toEqual([]);
  });
});
