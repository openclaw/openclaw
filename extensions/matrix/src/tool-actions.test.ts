import { beforeEach, describe, expect, it } from "vitest";
import {
  getMatrixActionMocks,
  resetMatrixActionMocks,
  runMatrixAction,
} from "./tool-actions.test-support.js";
import type { CoreConfig } from "./types.js";

const mocks = getMatrixActionMocks();
const emptyCfg: CoreConfig = {};
const cfg: CoreConfig = {
  channels: {
    matrix: {
      actions: {
        messages: true,
        reactions: true,
        pins: true,
        profile: true,
        memberInfo: true,
        channelInfo: true,
      },
    },
  },
};
const roomId = "!room:example";
const target = { roomId, messageId: "$msg" };
const account = { accountId: "ops" };
const authorizedOpts = { cfg, ...account, client: mocks.matrixClient };
const mediaLocalRoots = ["/tmp/openclaw-matrix-test"];

describe("Matrix public message actions", () => {
  beforeEach(resetMatrixActionMocks);

  it("parses snake_case vote params and forwards normalized selectors", async () => {
    const result = await runMatrixAction(
      "poll-vote",
      {
        account_id: "main",
        room_id: roomId,
        poll_id: "$poll",
        poll_option_id: "a1",
        poll_option_ids: ["a2", ""],
        poll_option_index: "2",
        poll_option_indexes: ["1", "bogus"],
      },
      emptyCfg,
    );
    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith(roomId, "$poll", {
      cfg: emptyCfg,
      accountId: "main",
      client: mocks.matrixClient,
      optionIds: ["a2", "a1"],
      optionIndexes: [1, 2],
    });
    expect(result.details).toEqual({
      ok: true,
      result: {
        eventId: "evt-poll-vote",
        roomId,
        pollId: "$poll",
        answerIds: ["a1", "a2"],
        labels: ["Pizza", "Sushi"],
        maxSelections: 2,
      },
    });
  });

  it("rejects missing poll ids", async () => {
    await expect(
      runMatrixAction("poll-vote", { roomId, pollOptionIndex: 1 }, emptyCfg),
    ).rejects.toThrow("pollId required");
  });

  it("rejects fractional poll option indexes before voting", async () => {
    await expect(
      runMatrixAction("poll-vote", { roomId, pollId: "$poll", pollOptionIndex: 1.5 }, emptyCfg),
    ).rejects.toThrow("pollOptionIndex must be a positive integer.");
    await expect(
      runMatrixAction(
        "poll-vote",
        { roomId, pollId: "$poll", pollOptionIndexes: [1, 2.5] },
        emptyCfg,
      ),
    ).rejects.toThrow("pollOptionIndexes must contain positive integers.");
    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("accepts messageId as a pollId alias for poll votes", async () => {
    await runMatrixAction(
      "poll-vote",
      { roomId, messageId: "$poll", pollOptionIndex: 1 },
      emptyCfg,
    );
    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith(roomId, "$poll", {
      cfg: emptyCfg,
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
        emptyCfg,
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(mocks.voteMatrixPoll).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to add reactions", async () => {
    await runMatrixAction("react", { ...target, emoji: "👍" }, cfg, account);
    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith(roomId, "$msg", "👍", authorizedOpts);
  });

  it("lists custom emotes only after authorizing the selected Matrix room", async () => {
    const result = await runMatrixAction(
      "emoji-list",
      { roomId: `room:${roomId}`, limit: 5 },
      cfg,
      {
        ...account,
        requesterAccountId: "ops",
        toolContext: { currentChannelId: `room:${roomId}`, currentChannelProvider: "matrix" },
      },
    );
    expect(mocks.listMatrixEmojis).toHaveBeenCalledWith(roomId, { ...authorizedOpts, limit: 5 });
    expect(result.details).toEqual({
      ok: true,
      emojis: [{ name: "party", identifier: "party", url: "mxc://example.org/party" }],
    });
  });

  it("rejects custom-emote discovery when reactions or room access are disabled", async () => {
    const params = { roomId: "!blocked:example" };
    await expect(
      runMatrixAction("emoji-list", params, {
        channels: { matrix: { actions: { reactions: false } } },
      }),
    ).rejects.toThrow("Matrix reactions are disabled.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );
    await expect(runMatrixAction("emoji-list", params, emptyCfg)).rejects.toThrow(
      "Matrix read target is not allowed.",
    );
    expect(mocks.listMatrixEmojis).not.toHaveBeenCalled();
  });

  it.each([
    { action: "react", params: { emoji: "👍" }, providerCall: mocks.reactMatrixMessage },
    { action: "edit", params: { message: "updated" }, providerCall: mocks.editMatrixMessage },
    { action: "delete", params: {}, providerCall: mocks.deleteMatrixMessage },
  ] as const)(
    "rejects blocked $action before mutating Matrix",
    async ({ action, params, providerCall }) => {
      mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
        new Error("Matrix read target is not allowed."),
      );
      await expect(
        runMatrixAction(action, { ...target, roomId: "!blocked:example", ...params }, cfg),
      ).rejects.toThrow("Matrix read target is not allowed.");
      expect(providerCall).not.toHaveBeenCalled();
    },
  );

  it("passes account-scoped opts to remove reactions", async () => {
    await runMatrixAction(
      "react",
      {
        room_id: roomId,
        message_id: "$msg",
        emoji: "👍",
        remove: true,
      },
      cfg,
      account,
    );
    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith(roomId, "$msg", {
      ...authorizedOpts,
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const result = await runMatrixAction(
      "reactions",
      {
        room_id: roomId,
        message_id: "$msg",
        limit: "5",
      },
      cfg,
      account,
    );
    expect(mocks.listMatrixReactions).toHaveBeenCalledWith(roomId, "$msg", {
      ...authorizedOpts,
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
    });
  });

  it("preserves indented text and scoped options on message sends", async () => {
    const message = "    @room";
    await runMatrixAction(
      "send",
      {
        to: `room:${roomId}`,
        message,
        threadId: "$thread",
      },
      cfg,
      { ...account, mediaLocalRoots },
    );
    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith(`room:${roomId}`, message, {
      cfg,
      ...account,
      mediaUrl: undefined,
      mediaLocalRoots,
      replyToId: undefined,
      threadId: "$thread",
    });
  });

  it("preserves indented Markdown on message edits", async () => {
    const message = "    @alice:example.org";
    await runMatrixAction("edit", { ...target, message }, cfg);
    expect(mocks.editMatrixMessage.mock.lastCall?.[2]).toBe(message);
  });

  it("accepts media-only sends with shared aliases, voice flags, and workspace access", async () => {
    const mediaAccess = {
      localRoots: mediaLocalRoots,
      readFile: async () => Buffer.from("chart"),
      workspaceDir: mediaLocalRoots[0],
    };
    await runMatrixAction(
      "send",
      {
        to: `room:${roomId}`,
        path: "/tmp/clip.mp3",
        asVoice: true,
      },
      cfg,
      { ...account, mediaAccess, mediaLocalRoots },
    );
    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith(`room:${roomId}`, undefined, {
      cfg,
      ...account,
      mediaUrl: "/tmp/clip.mp3",
      mediaAccess,
      mediaLocalRoots,
      replyToId: undefined,
      threadId: undefined,
      audioAsVoice: true,
    });
    expect(mocks.sendMatrixMessage.mock.lastCall?.[2]?.mediaAccess).toBe(mediaAccess);
  });

  it("keeps blank IDs on authorized paginated history and projects readable messages", async () => {
    const message = {
      eventId: "$message",
      sender: "@alice:example.org",
      body: "hello from Matrix",
      msgtype: "m.text",
      timestamp: 1_750_000_000_000,
    };
    mocks.readMatrixMessages.mockResolvedValueOnce({
      messages: [message, { eventId: "$sparse" }],
      nextBatch: "next",
      prevBatch: "previous",
    });
    const result = await runMatrixAction(
      "read",
      {
        roomId: `room:${roomId}`,
        messageId: "   ",
        limit: 7,
        before: "before",
        after: "after",
        threadId: "$thread",
      },
      cfg,
      account,
    );
    expect(mocks.readMatrixMessages).toHaveBeenCalledWith(roomId, {
      ...authorizedOpts,
      limit: 7,
      before: "before",
      after: "after",
      threadId: "$thread",
    });
    expect(mocks.readMatrixMessage).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      ok: true,
      roomId,
      threadId: "$thread",
      messages: [
        {
          ...message,
          id: "$message",
          authorTag: "@alice:example.org",
          content: "hello from Matrix",
          ts: "2025-06-15T15:06:40.000Z",
        },
        { eventId: "$sparse", id: "$sparse" },
      ],
      nextBatch: "next",
      prevBatch: "previous",
    });
  });

  it("reads exactly the requested message id instead of room history", async () => {
    mocks.readMatrixMessage.mockResolvedValueOnce({
      eventId: "$older",
      sender: "@alice:example.org",
      body: "older",
      timestamp: 1000,
    });
    const result = await runMatrixAction(
      "read",
      {
        roomId: `room:${roomId}`,
        messageId: "  $older  ",
        limit: 5,
        before: "before",
        after: "after",
        threadId: "$thread",
      },
      cfg,
      account,
    );
    expect(mocks.readMatrixMessage).toHaveBeenCalledWith(roomId, "$older", authorizedOpts);
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      ok: true,
      roomId,
      messages: [
        {
          eventId: "$older",
          sender: "@alice:example.org",
          body: "older",
          timestamp: 1000,
          ts: "1970-01-01T00:00:01.000Z",
          id: "$older",
          authorTag: "@alice:example.org",
          content: "older",
        },
      ],
    });
  });

  it("does not fall back to history when the exact event cannot be summarized", async () => {
    mocks.readMatrixMessage.mockRejectedValueOnce(
      new Error("Matrix message $missing was not found in room !room:example."),
    );
    await expect(
      runMatrixAction("read", { roomId, messageId: "$missing" }, emptyCfg),
    ).rejects.toThrow("was not found");
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("applies account action overrides before authorizing or fetching exact reads", async () => {
    await expect(
      runMatrixAction(
        "read",
        { roomId, messageId: "$older" },
        {
          channels: {
            matrix: {
              actions: { messages: true },
              accounts: { ops: { actions: { messages: false } } },
            },
          },
        },
        account,
      ),
    ).rejects.toThrow("Matrix messages are disabled.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    expect(mocks.readMatrixMessage).not.toHaveBeenCalled();
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("retains the read-policy gate before exact event selection", async () => {
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );
    await expect(
      runMatrixAction("read", { roomId: "!blocked:example", messageId: "$older" }, emptyCfg, {
        ...account,
        requesterAccountId: "other",
        toolContext: { currentChannelId: "!current:example", currentChannelProvider: "matrix" },
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(mocks.readMatrixMessage).not.toHaveBeenCalled();
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("validates fractional limits before exact event selection", async () => {
    await expect(
      runMatrixAction("read", { roomId, messageId: "$older", limit: 1.5 }, emptyCfg),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    expect(mocks.readMatrixMessage).not.toHaveBeenCalled();
    expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
  });

  it("projects pinned Matrix events without removing their original event fields", async () => {
    const event = {
      eventId: "$pin",
      sender: "@alice:example.org",
      body: "pinned message",
      timestamp: 1_750_000_000_000,
    };
    mocks.listMatrixPins.mockResolvedValueOnce({ pinned: ["$pin"], events: [event] });
    const result = await runMatrixAction("list-pins", { roomId }, cfg, account);
    expect(mocks.listMatrixPins).toHaveBeenCalledWith(roomId, authorizedOpts);
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
    { action: "pin", expected: mocks.pinMatrixMessage, expectedPinned: ["$existing", "$pin"] },
    { action: "unpin", expected: mocks.unpinMatrixMessage, expectedPinned: ["$existing"] },
  ] as const)(
    "authorizes $action before reading pinned state",
    async ({ action, expected, expectedPinned }) => {
      const result = await runMatrixAction(
        action,
        { roomId: `room:${roomId}`, messageId: "$pin" },
        cfg,
        account,
      );
      expect(expected).toHaveBeenCalledWith(roomId, "$pin", authorizedOpts);
      expect(result.details).toEqual({ ok: true, pinned: expectedPinned });
    },
  );

  it("rejects blocked pins before reading or mutating pinned state", async () => {
    mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(
      new Error("Matrix read target is not allowed."),
    );
    await expect(
      runMatrixAction("pin", { roomId: "!blocked:example", messageId: "$pin" }, cfg),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(mocks.pinMatrixMessage).not.toHaveBeenCalled();
    expect(mocks.unpinMatrixMessage).not.toHaveBeenCalled();
    expect(mocks.listMatrixPins).not.toHaveBeenCalled();
  });

  it("passes account-scoped opts to member and room info actions", async () => {
    await runMatrixAction("member-info", { userId: "@u:example", roomId }, cfg, account);
    await runMatrixAction("channel-info", { roomId }, cfg, account);
    expect(mocks.getMatrixMemberInfo).toHaveBeenCalledWith("@u:example", {
      ...authorizedOpts,
      roomId,
    });
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith(roomId, authorizedOpts);
  });

  it("forwards scoped self-profile edits and local avatar access to the profile owner", async () => {
    const result = await runMatrixAction(
      "set-profile",
      {
        display_name: "Ops Bot",
        avatar_url: "mxc://example/avatar",
        path: "/tmp/avatar.jpg",
      },
      cfg,
      { ...account, mediaLocalRoots, senderIsOwner: true },
    );
    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg,
      account: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      avatarPath: "/tmp/avatar.jpg",
      mediaLocalRoots,
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
});
