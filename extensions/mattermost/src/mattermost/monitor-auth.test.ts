import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const evaluateSenderGroupAccessForPolicy = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveControlCommandGate = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveControlCommandGate,
}));

describe("mattermost monitor auth", () => {
  let authorizeMattermostCommandInvocation: typeof import("./monitor-auth.js").authorizeMattermostCommandInvocation;
  let isMattermostSenderAllowed: typeof import("./monitor-auth.js").isMattermostSenderAllowed;
  let normalizeMattermostAllowEntry: typeof import("./monitor-auth.js").normalizeMattermostAllowEntry;
  let normalizeMattermostAllowList: typeof import("./monitor-auth.js").normalizeMattermostAllowList;
  let resolveMattermostEffectiveAllowFromLists: typeof import("./monitor-auth.js").resolveMattermostEffectiveAllowFromLists;

  beforeAll(async () => {
    ({
      authorizeMattermostCommandInvocation,
      isMattermostSenderAllowed,
      normalizeMattermostAllowEntry,
      normalizeMattermostAllowList,
      resolveMattermostEffectiveAllowFromLists,
    } = await import("./monitor-auth.js"));
  });

  beforeEach(() => {
    evaluateSenderGroupAccessForPolicy.mockReset();
    isDangerousNameMatchingEnabled.mockReset();
    resolveControlCommandGate.mockReset();
  });

  it("normalizes allowlist entries and resolves effective lists", () => {
    expect(normalizeMattermostAllowEntry(" @Alice ")).toBe("alice");
    expect(normalizeMattermostAllowEntry("mattermost:Bob")).toBe("bob");
    expect(normalizeMattermostAllowEntry("*")).toBe("*");
    expect(normalizeMattermostAllowList([" Alice ", "user:alice", "ALICE", "*"])).toEqual([
      "alice",
      "*",
    ]);
    expect(
      resolveMattermostEffectiveAllowFromLists({
        allowFrom: [" Alice "],
        groupAllowFrom: [" Team "],
        storeAllowFrom: ["Store"],
        dmPolicy: "pairing",
      }),
    ).toEqual({
      effectiveAllowFrom: ["alice", "store"],
      effectiveGroupAllowFrom: ["team"],
    });
  });

  it("checks sender allowlists against normalized ids and names", () => {
    expect(
      isMattermostSenderAllowed({
        senderId: "@Alice",
        senderName: "Alice",
        allowFrom: [" mattermost:alice "],
        allowNameMatching: true,
      }),
    ).toBe(true);
    expect(
      isMattermostSenderAllowed({
        senderId: "@Mallory",
        senderName: "Mallory",
        allowFrom: [" mattermost:alice "],
        allowNameMatching: true,
      }),
    ).toBe(false);
  });

  it("authorizes direct messages in open mode and blocks disabled/group-restricted channels", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(false);
    resolveControlCommandGate.mockReturnValue({
      commandAuthorized: false,
      shouldBlock: false,
    });
    evaluateSenderGroupAccessForPolicy.mockReturnValue({
      allowed: false,
      reason: "empty_allowlist",
    });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "open" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        allowTextCommands: false,
        hasControlCommand: false,
      }),
    ).toMatchObject({
      ok: true,
      commandAuthorized: true,
      kind: "direct",
      roomLabel: "#alice",
    });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "disabled" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        allowTextCommands: false,
        hasControlCommand: false,
      }),
    ).toMatchObject({
      ok: false,
      denyReason: "dm-disabled",
    });

    expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { groupPolicy: "allowlist" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "chan-1",
        channelInfo: { type: "O", name: "town-square", display_name: "Town Square" } as never,
        allowTextCommands: true,
        hasControlCommand: false,
      }),
    ).toMatchObject({
      ok: false,
      denyReason: "channel-no-allowlist",
      kind: "channel",
    });
  });
});
