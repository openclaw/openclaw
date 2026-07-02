// Matrix tests cover tool actions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMatrixAction } from "./tool-actions.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  voteMatrixPoll: vi.fn(),
  reactMatrixMessage: vi.fn(),
  listMatrixReactions: vi.fn(),
  removeMatrixReactions: vi.fn(),
  readMatrixMessages: vi.fn(),
  sendMatrixMessage: vi.fn(),
  listMatrixPins: vi.fn(),
  getMatrixMemberInfo: vi.fn(),
  getMatrixRoomInfo: vi.fn(),
  applyMatrixProfileUpdate: vi.fn(),
  resolveMatrixRoomId: vi.fn(),
}));

vi.mock("./matrix/actions.js", () => {
  return {
    getMatrixMemberInfo: mocks.getMatrixMemberInfo,
    getMatrixRoomInfo: mocks.getMatrixRoomInfo,
    listMatrixReactions: mocks.listMatrixReactions,
    listMatrixPins: mocks.listMatrixPins,
    readMatrixMessages: mocks.readMatrixMessages,
    removeMatrixReactions: mocks.removeMatrixReactions,
    sendMatrixMessage: mocks.sendMatrixMessage,
    voteMatrixPoll: mocks.voteMatrixPoll,
  };
});

vi.mock("./matrix/send.js", () => {
  return {
    reactMatrixMessage: mocks.reactMatrixMessage,
    resolveMatrixRoomId: mocks.resolveMatrixRoomId,
  };
});

vi.mock("./profile-update.js", () => ({
  applyMatrixProfileUpdate: (...args: unknown[]) => mocks.applyMatrixProfileUpdate(...args),
}));

describe("handleMatrixAction pollVote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.voteMatrixPoll.mockResolvedValue({
      eventId: "evt-poll-vote",
      roomId: "!room:example",
      pollId: "$poll",
      answerIds: ["a1", "a2"],
      labels: ["Pizza", "Sushi"],
      maxSelections: 2,
    });
    mocks.listMatrixReactions.mockResolvedValue([{ key: "👍", count: 1, users: ["@u:example"] }]);
    mocks.listMatrixPins.mockResolvedValue({ pinned: ["$pin"], events: [] });
    mocks.removeMatrixReactions.mockResolvedValue({ removed: 1 });
    mocks.readMatrixMessages.mockResolvedValue({ roomId: "!room:example", messages: [] });
    mocks.sendMatrixMessage.mockResolvedValue({
      messageId: "$sent",
      roomId: "!room:example",
    });
    mocks.getMatrixMemberInfo.mockResolvedValue({ userId: "@u:example" });
    mocks.getMatrixRoomInfo.mockResolvedValue({ roomId: "!room:example" });
    mocks.resolveMatrixRoomId.mockImplementation(
      async (client: { resolveRoom?: (alias: string) => Promise<string | null> }, raw: string) => {
        if (raw.startsWith("#")) {
          const resolved = await client.resolveRoom?.(raw);
          if (!resolved) {
            throw new Error(`Matrix alias ${raw} could not be resolved`);
          }
          return resolved;
        }
        return raw;
      },
    );
    mocks.applyMatrixProfileUpdate.mockResolvedValue({
      accountId: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      profile: {
        displayNameUpdated: true,
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
        convertedAvatarFromHttp: false,
      },
      configPath: "channels.matrix.accounts.ops",
    });
  });

  it("parses snake_case vote params and forwards normalized selectors", async () => {
    const cfg = {} as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "pollVote",
        account_id: "main",
        room_id: "!room:example",
        poll_id: "$poll",
        poll_option_id: "a1",
        poll_option_ids: ["a2", ""],
        poll_option_index: "2",
        poll_option_indexes: ["1", "bogus"],
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      accountId: "main",
      optionIds: ["a2", "a1"],
      optionIndexes: [1, 2],
    });
    expect(result.details).toEqual({
      ok: true,
      result: {
        eventId: "evt-poll-vote",
        roomId: "!room:example",
        pollId: "$poll",
        answerIds: ["a1", "a2"],
        labels: ["Pizza", "Sushi"],
        maxSelections: 2,
      },
    });
  });

  it("rejects missing poll ids", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollOptionIndex: 1,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollId required");
  });

  it("rejects fractional poll option indexes before voting", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollId: "$poll",
          pollOptionIndex: 1.5,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollOptionIndex must be a positive integer.");
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          roomId: "!room:example",
          pollId: "$poll",
          pollOptionIndexes: [1, 2.5],
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollOptionIndexes must contain positive integers.");
    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("accepts messageId as a pollId alias for poll votes", async () => {
    const cfg = {} as CoreConfig;
    await handleMatrixAction(
      {
        action: "pollVote",
        roomId: "!room:example",
        messageId: "$poll",
        pollOptionIndex: 1,
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      optionIds: [],
      optionIndexes: [1],
    });
  });

  it("passes account-scoped opts to add reactions", async () => {
    const cfg = {
      channels: { matrix: { groupPolicy: "open", actions: { reactions: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "react",
        accountId: "ops",
        roomId: "!room:example",
        messageId: "$msg",
        emoji: "👍",
      },
      cfg,
    );

    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith("!room:example", "$msg", "👍", {
      cfg,
      accountId: "ops",
    });
  });

  it("allows reaction adds without read allowlist room matches", async () => {
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "!allowed:example": {},
          },
          actions: { reactions: true },
        },
      },
    } as CoreConfig;

    await handleMatrixAction(
      {
        action: "react",
        roomId: "!other:example",
        messageId: "$msg",
        emoji: "👍",
      },
      cfg,
    );

    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith("!other:example", "$msg", "👍", {
      cfg,
    });
    expect(mocks.removeMatrixReactions).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to remove reactions", async () => {
    const cfg = {
      channels: { matrix: { groupPolicy: "open", actions: { reactions: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "react",
        account_id: "ops",
        room_id: "!room:example",
        message_id: "$msg",
        emoji: "👍",
        remove: true,
      },
      cfg,
    );

    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const cfg = {
      channels: { matrix: { groupPolicy: "open", actions: { reactions: true } } },
    } as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "reactions",
        account_id: "ops",
        room_id: "!room:example",
        message_id: "$msg",
        limit: "5",
      },
      cfg,
    );

    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
    });
  });

  it("blocks reaction reads outside the Matrix room allowlist", async () => {
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "!allowed:example": {},
          },
          actions: { reactions: true },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "reactions",
          roomId: "!other:example",
          messageId: "$msg",
        },
        cfg,
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.listMatrixReactions).not.toHaveBeenCalled();
  });

  it("defaults Matrix reaction reads to the allowlist provider policy", async () => {
    const cfg = {
      channels: {
        matrix: {
          actions: { reactions: true },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "reactions",
          roomId: "!other:example",
          messageId: "$msg",
        },
        cfg,
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.listMatrixReactions).not.toHaveBeenCalled();
  });

  it("blocks forged trusted current Matrix DM reads under default group allowlist", async () => {
    const cfg = {
      channels: {
        matrix: {
          actions: { messages: true },
          dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "readMessages",
          roomId: "!dm:example",
        },
        cfg,
        {
          toolContext: {
            currentChannelId: "room:!dm:example",
            currentDirectUserId: "@alice:example.org",
          },
        },
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");

    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("blocks trusted current Matrix DM reads outside dm.allowFrom", async () => {
    const cfg = {
      channels: {
        matrix: {
          actions: { messages: true },
          dm: { policy: "allowlist", allowFrom: ["@bob:example.org"] },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "readMessages",
          roomId: "!dm:example",
        },
        cfg,
        {
          toolContext: {
            currentChannelId: "room:!dm:example",
            currentDirectUserId: "@alice:example.org",
          },
        },
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("blocks trusted current Matrix DM reads when dm policy is disabled", async () => {
    const cfg = {
      channels: {
        matrix: {
          actions: { messages: true },
          dm: { policy: "disabled" as never, allowFrom: ["@alice:example.org"] },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "readMessages",
          roomId: "!dm:example",
        },
        cfg,
        {
          toolContext: {
            currentChannelId: "room:!dm:example",
            currentDirectUserId: "@alice:example.org",
          },
        },
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("allows unmatched Matrix room reads under open policy when another room is configured", async () => {
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "open",
          groups: {
            "!blocked:example": { enabled: false },
          },
          actions: { reactions: true },
        },
      },
    } as CoreConfig;

    const result = await handleMatrixAction(
      {
        action: "reactions",
        roomId: "!other:example",
        messageId: "$msg",
      },
      cfg,
    );

    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!other:example", "$msg", {
      cfg,
      limit: undefined,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
    });
  });

  it("rejects fractional reaction limits before listing reactions", async () => {
    const cfg = {
      channels: { matrix: { groupPolicy: "open", actions: { reactions: true } } },
    } as CoreConfig;
    await expect(
      handleMatrixAction(
        {
          action: "reactions",
          roomId: "!room:example",
          messageId: "$msg",
          limit: 5.5,
        },
        cfg,
      ),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(mocks.listMatrixReactions).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        content: "hello",
        threadId: "$thread",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", "hello", {
      cfg,
      accountId: "ops",
      mediaUrl: undefined,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: "$thread",
    });
  });

  it("accepts media-only message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        mediaUrl: "file:///tmp/photo.png",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      cfg,
      accountId: "ops",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: undefined,
    });
  });

  it("accepts shared media aliases and voice-send flags", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "sendMessage",
        accountId: "ops",
        to: "room:!room:example",
        path: "/tmp/clip.mp3",
        asVoice: true,
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      cfg,
      accountId: "ops",
      mediaUrl: "/tmp/clip.mp3",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: undefined,
      audioAsVoice: true,
    });
  });

  it("passes mediaLocalRoots to profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "setProfile",
        accountId: "ops",
        avatarPath: "/tmp/avatar.jpg",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: undefined,
      avatarUrl: undefined,
      avatarPath: "/tmp/avatar.jpg",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
    });
  });

  it("passes account-scoped opts to pin listing", async () => {
    const cfg = {
      channels: { matrix: { groupPolicy: "open", actions: { pins: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "listPins",
        accountId: "ops",
        roomId: "!room:example",
      },
      cfg,
    );

    expect(mocks.listMatrixPins).toHaveBeenCalledWith("!room:example", {
      cfg,
      accountId: "ops",
    });
  });

  it("passes account-scoped opts to member and room info actions", async () => {
    const memberCfg = {
      channels: { matrix: { groupPolicy: "open", actions: { memberInfo: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "memberInfo",
        accountId: "ops",
        userId: "@u:example",
        roomId: "!room:example",
      },
      memberCfg,
    );
    const roomCfg = {
      channels: { matrix: { groupPolicy: "open", actions: { channelInfo: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        action: "channelInfo",
        accountId: "ops",
        roomId: "!room:example",
      },
      roomCfg,
    );

    expect(mocks.getMatrixMemberInfo).toHaveBeenCalledWith("@u:example", {
      cfg: memberCfg,
      accountId: "ops",
      roomId: "!room:example",
    });
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("!room:example", {
      cfg: roomCfg,
      accountId: "ops",
    });
  });

  it("blocks room metadata reads outside the Matrix room allowlist", async () => {
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "!allowed:example": {},
          },
          actions: { channelInfo: true },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "channelInfo",
          roomId: "!other:example",
        },
        cfg,
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.getMatrixRoomInfo).not.toHaveBeenCalled();
  });

  it("allows room metadata reads when a configured Matrix alias resolves to the room id", async () => {
    const client = {
      resolveRoom: vi.fn().mockResolvedValue("!room:example"),
    };
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "#ops:example": {},
          },
          actions: { channelInfo: true },
        },
      },
    } as CoreConfig;

    await handleMatrixAction(
      {
        action: "channelInfo",
        roomId: "!room:example",
      },
      cfg,
      { client: client as never },
    );

    expect(client.resolveRoom).toHaveBeenCalledWith("#ops:example");
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("!room:example", {
      cfg,
      client,
    });
  });

  it("allows room metadata reads when a requested Matrix alias resolves to a configured room id", async () => {
    const client = {
      resolveRoom: vi.fn().mockResolvedValue("!room:example"),
    };
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          groups: {
            "!room:example": {},
          },
          actions: { channelInfo: true },
        },
      },
    } as CoreConfig;

    await handleMatrixAction(
      {
        action: "channelInfo",
        roomId: "#ops:example",
      },
      cfg,
      { client: client as never },
    );

    expect(client.resolveRoom).toHaveBeenCalledWith("#ops:example");
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("#ops:example", {
      cfg,
      client,
    });
  });

  it("blocks room metadata reads when a disabled Matrix alias resolves under open policy", async () => {
    const client = {
      resolveRoom: vi.fn().mockResolvedValue("!room:example"),
    };
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "open",
          groups: {
            "#ops:example": { enabled: false },
          },
          actions: { channelInfo: true },
        },
      },
    } as CoreConfig;

    await expect(
      handleMatrixAction(
        {
          action: "channelInfo",
          roomId: "!room:example",
        },
        cfg,
        { client: client as never },
      ),
    ).rejects.toThrow("Matrix read target room is not allowed.");
    expect(mocks.getMatrixRoomInfo).not.toHaveBeenCalled();
  });

  it("persists self-profile updates through the shared profile helper", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    const result = await handleMatrixAction(
      {
        action: "setProfile",
        account_id: "ops",
        display_name: "Ops Bot",
        avatar_url: "mxc://example/avatar",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
    });
    expect(result.details).toEqual({
      ok: true,
      accountId: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      profile: {
        displayNameUpdated: true,
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
        convertedAvatarFromHttp: false,
      },
      configPath: "channels.matrix.accounts.ops",
    });
  });

  it("accepts local avatar paths for self-profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        action: "setProfile",
        accountId: "ops",
        path: "/tmp/avatar.jpg",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: undefined,
      avatarUrl: undefined,
      avatarPath: "/tmp/avatar.jpg",
    });
  });

  it("respects account-scoped action overrides when gating direct tool actions", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "sendMessage",
          accountId: "ops",
          to: "room:!room:example",
          content: "hello",
        },
        {
          channels: {
            matrix: {
              actions: {
                messages: true,
              },
              accounts: {
                ops: {
                  actions: {
                    messages: false,
                  },
                },
              },
            },
          },
        } as CoreConfig,
      ),
    ).rejects.toThrow("Matrix messages are disabled.");
  });
});
