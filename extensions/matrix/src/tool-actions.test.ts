import { beforeEach, describe, expect, it } from "vitest";
import {
  getMatrixActionMocks,
  resetMatrixActionMocks,
  runMatrixAction,
} from "./tool-actions.test-support.js";
import type { CoreConfig } from "./types.js";

const mocks = getMatrixActionMocks();

describe("Matrix public message actions", () => {
  beforeEach(resetMatrixActionMocks);

  it("parses snake_case vote params and forwards normalized selectors", async () => {
    const cfg = {} as CoreConfig;
    const result = await runMatrixAction(
      "poll-vote",
      {
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
      client: mocks.matrixClient,
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
      runMatrixAction(
        "poll-vote",
        {
          roomId: "!room:example",
          pollOptionIndex: 1,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollId required");
  });

  it("rejects fractional poll option indexes before voting", async () => {
    await expect(
      runMatrixAction(
        "poll-vote",
        {
          roomId: "!room:example",
          pollId: "$poll",
          pollOptionIndex: 1.5,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollOptionIndex must be a positive integer.");
    await expect(
      runMatrixAction(
        "poll-vote",
        {
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
    await runMatrixAction(
      "poll-vote",
      {
        roomId: "!room:example",
        messageId: "$poll",
        pollOptionIndex: 1,
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      client: mocks.matrixClient,
      optionIds: [],
      optionIndexes: [1],
    });
  });

  it("authorizes the room before reading the poll", async () => {
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );

    await expect(
      runMatrixAction(
        "poll-vote",
        {
          roomId: "!blocked:example",
          pollId: "$poll",
          pollOptionIndex: 1,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");

    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to add reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await runMatrixAction(
      "react",
      {
        roomId: "!room:example",
        messageId: "$msg",
        emoji: "👍",
      },
      cfg,
      { accountId: "ops" },
    );

    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith("!room:example", "$msg", "👍", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it("lists custom emotes only after authorizing the selected Matrix room", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    const result = await runMatrixAction(
      "emoji-list",
      {
        roomId: "room:!room:example",
        limit: 5,
      },
      cfg,
      {
        requesterAccountId: "ops",
        toolContext: { currentChannelId: "room:!room:example", currentChannelProvider: "matrix" },
        accountId: "ops",
      },
    );

    expect(mocks.listMatrixEmojis).toHaveBeenCalledWith("!room:example", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      emojis: [{ name: "party", identifier: "party", url: "mxc://example.org/party" }],
    });
  });

  it("rejects custom-emote discovery when reactions or room access are disabled", async () => {
    const params = { action: "emoji-list", roomId: "!blocked:example" };

    await expect(
      runMatrixAction(
        "emoji-list",
        {
          roomId: params.roomId,
        },
        {
          channels: { matrix: { actions: { reactions: false } } },
        } as CoreConfig,
      ),
    ).rejects.toThrow("Matrix reactions are disabled.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();

    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );
    await expect(
      runMatrixAction(
        "emoji-list",
        {
          roomId: params.roomId,
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(mocks.listMatrixEmojis).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: "react",
      params: { emoji: "👍" },
      providerCall: mocks.reactMatrixMessage,
    },
    {
      action: "edit",
      params: { message: "updated" },
      providerCall: mocks.editMatrixMessage,
    },
    {
      action: "delete",
      params: {},
      providerCall: mocks.deleteMatrixMessage,
    },
  ] as const)(
    "rejects blocked $action before mutating Matrix",
    async ({ action, params, providerCall }) => {
      mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
        new Error("Matrix read target is not allowed."),
      );
      const cfg = {
        channels: {
          matrix: {
            actions: {
              messages: true,
              reactions: true,
            },
          },
        },
      } as CoreConfig;

      await expect(
        runMatrixAction(
          action,
          {
            roomId: "!blocked:example",
            messageId: "$msg",
            ...params,
          },
          cfg,
        ),
      ).rejects.toThrow("Matrix read target is not allowed.");

      expect(providerCall).not.toHaveBeenCalled();
    },
  );

  it("passes account-scoped opts to remove reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await runMatrixAction(
      "react",
      {
        room_id: "!room:example",
        message_id: "$msg",
        emoji: "👍",
        remove: true,
      },
      cfg,
      { accountId: "ops" },
    );

    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    const result = await runMatrixAction(
      "reactions",
      {
        room_id: "!room:example",
        message_id: "$msg",
        limit: "5",
      },
      cfg,
      { accountId: "ops" },
    );

    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
    });
  });

  it("rejects fractional reaction limits before listing reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await expect(
      runMatrixAction(
        "reactions",
        {
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
    await runMatrixAction(
      "send",
      {
        to: "room:!room:example",
        message: "hello",
        threadId: "$thread",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"], accountId: "ops" },
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

  it.each([
    { action: "send", markdown: "    @room" },
    { action: "send", markdown: "    @alice:example.org" },
    { action: "edit", markdown: "    @room" },
    { action: "edit", markdown: "    @alice:example.org" },
  ] as const)(
    "preserves indented Markdown for $action: $markdown",
    async ({ action, markdown }) => {
      const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;

      await runMatrixAction(
        action,
        {
          to: "room:!room:example",
          roomId: "!room:example",
          messageId: "$original",
          message: markdown,
        },
        cfg,
      );

      const providerCall =
        action === "send"
          ? mocks.sendMatrixMessage.mock.lastCall?.[1]
          : mocks.editMatrixMessage.mock.lastCall?.[2];
      expect(providerCall).toBe(markdown);
    },
  );

  it("returns the authorized room and thread with message reads", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    const result = await runMatrixAction(
      "read",
      {
        roomId: "room:!room:example",
        threadId: "$thread",
        limit: 5,
      },
      cfg,
      { accountId: "ops" },
    );

    expect(mocks.readMatrixMessages).toHaveBeenCalledWith("!room:example", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
      limit: 5,
      before: undefined,
      after: undefined,
      threadId: "$thread",
    });
    expect(result.details).toEqual({
      ok: true,
      roomId: "!room:example",
      threadId: "$thread",
      messages: [{ eventId: "$message", id: "$message" }],
      nextBatch: "next",
    });
  });

  it("projects Matrix message summaries for human-readable CLI output", async () => {
    mocks.readMatrixMessages.mockResolvedValueOnce({
      messages: [
        {
          eventId: "$message",
          sender: "@alice:example.org",
          body: "hello from Matrix",
          msgtype: "m.text",
          timestamp: 1_750_000_000_000,
        },
      ],
      nextBatch: "next",
    });

    const result = await runMatrixAction(
      "read",
      {
        roomId: "!room:example",
      },
      {
        channels: { matrix: { actions: { messages: true } } },
      } as CoreConfig,
    );

    expect(result.details).toEqual({
      ok: true,
      roomId: "!room:example",
      messages: [
        {
          eventId: "$message",
          sender: "@alice:example.org",
          body: "hello from Matrix",
          msgtype: "m.text",
          timestamp: 1_750_000_000_000,
          id: "$message",
          authorTag: "@alice:example.org",
          content: "hello from Matrix",
          ts: "2025-06-15T15:06:40.000Z",
        },
      ],
      nextBatch: "next",
    });
  });

  it("accepts media-only message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    const mediaAccess = {
      localRoots: ["/tmp/openclaw-matrix-test"],
      readFile: async () => Buffer.from("chart"),
      workspaceDir: "/tmp/openclaw-matrix-test",
    };
    await runMatrixAction(
      "send",
      {
        to: "room:!room:example",
        mediaUrl: "chart.png",
      },
      cfg,
      { mediaAccess, mediaLocalRoots: mediaAccess.localRoots, accountId: "ops" },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      cfg,
      accountId: "ops",
      mediaUrl: "chart.png",
      mediaAccess,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      replyToId: undefined,
      threadId: undefined,
    });
    expect(mocks.sendMatrixMessage.mock.lastCall?.[2]?.mediaAccess).toBe(mediaAccess);
  });

  it("accepts shared media aliases and voice-send flags", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await runMatrixAction(
      "send",
      {
        to: "room:!room:example",
        path: "/tmp/clip.mp3",
        asVoice: true,
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"], accountId: "ops" },
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
    await runMatrixAction(
      "set-profile",
      {
        avatarPath: "/tmp/avatar.jpg",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"], accountId: "ops", senderIsOwner: true },
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
    const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;
    await runMatrixAction(
      "list-pins",
      {
        roomId: "!room:example",
      },
      cfg,
      { accountId: "ops" },
    );

    expect(mocks.listMatrixPins).toHaveBeenCalledWith("!room:example", {
      cfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it("projects pinned Matrix events without removing their original event fields", async () => {
    const event = {
      eventId: "$pin",
      sender: "@alice:example.org",
      body: "pinned message",
      timestamp: 1_750_000_000_000,
    };
    mocks.listMatrixPins.mockResolvedValueOnce({ pinned: ["$pin"], events: [event] });

    const result = await runMatrixAction(
      "list-pins",
      {
        roomId: "!room:example",
      },
      {
        channels: { matrix: { actions: { pins: true } } },
      } as CoreConfig,
    );

    expect(result.details).toEqual({
      ok: true,
      pinned: ["$pin"],
      events: [event],
      pins: [
        {
          ...event,
          id: "$pin",
          authorTag: "@alice:example.org",
          content: "pinned message",
          ts: "2025-06-15T15:06:40.000Z",
        },
      ],
    });
  });

  it.each([
    {
      action: "pin",
      expected: mocks.pinMatrixMessage,
      expectedPinned: ["$existing", "$pin"],
    },
    {
      action: "unpin",
      expected: mocks.unpinMatrixMessage,
      expectedPinned: ["$existing"],
    },
  ] as const)(
    "authorizes $action before reading pinned state",
    async ({ action, expected, expectedPinned }) => {
      const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;
      const result = await runMatrixAction(
        action,
        {
          roomId: "room:!room:example",
          messageId: "$pin",
        },
        cfg,
        { accountId: "ops" },
      );

      expect(expected).toHaveBeenCalledWith("!room:example", "$pin", {
        cfg,
        accountId: "ops",
        client: mocks.matrixClient,
      });
      expect(result.details).toEqual({ ok: true, pinned: expectedPinned });
    },
  );

  it.each(["pin", "unpin"] as const)(
    "rejects blocked %s before reading or mutating pinned state",
    async (action) => {
      mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
        new Error("Matrix read target is not allowed."),
      );
      const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;

      await expect(
        runMatrixAction(
          action,
          {
            roomId: "!blocked:example",
            messageId: "$pin",
          },
          cfg,
        ),
      ).rejects.toThrow("Matrix read target is not allowed.");

      expect(mocks.pinMatrixMessage).not.toHaveBeenCalled();
      expect(mocks.unpinMatrixMessage).not.toHaveBeenCalled();
      expect(mocks.listMatrixPins).not.toHaveBeenCalled();
    },
  );

  it("passes account-scoped opts to member and room info actions", async () => {
    const memberCfg = {
      channels: { matrix: { actions: { memberInfo: true } } },
    } as CoreConfig;
    await runMatrixAction(
      "member-info",
      {
        userId: "@u:example",
        roomId: "!room:example",
      },
      memberCfg,
      { accountId: "ops" },
    );
    const roomCfg = { channels: { matrix: { actions: { channelInfo: true } } } } as CoreConfig;
    await runMatrixAction(
      "channel-info",
      {
        roomId: "!room:example",
      },
      roomCfg,
      { accountId: "ops" },
    );

    expect(mocks.getMatrixMemberInfo).toHaveBeenCalledWith("@u:example", {
      cfg: memberCfg,
      accountId: "ops",
      roomId: "!room:example",
      client: mocks.matrixClient,
    });
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("!room:example", {
      cfg: roomCfg,
      accountId: "ops",
      client: mocks.matrixClient,
    });
  });

  it("persists self-profile updates through the shared profile helper", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    const result = await runMatrixAction(
      "set-profile",
      {
        display_name: "Ops Bot",
        avatar_url: "mxc://example/avatar",
      },
      cfg,
      { accountId: "ops", senderIsOwner: true },
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
    await runMatrixAction(
      "set-profile",
      {
        path: "/tmp/avatar.jpg",
      },
      cfg,
      { accountId: "ops", senderIsOwner: true },
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: undefined,
      avatarUrl: undefined,
      avatarPath: "/tmp/avatar.jpg",
    });
  });

  it("respects account-scoped action overrides for public actions", async () => {
    await expect(
      runMatrixAction(
        "send",
        {
          to: "room:!room:example",
          message: "hello",
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
        { accountId: "ops" },
      ),
    ).rejects.toThrow("Matrix messages are disabled.");
  });
});
