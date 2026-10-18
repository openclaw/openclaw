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
const blockedMessage = "Matrix read target is not allowed.";
function blockReadTarget() {
  mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(new Error(blockedMessage));
}
type BlockedCase = [
  action: Parameters<typeof runMatrixAction>[0],
  params: Record<string, unknown>,
  forbidden: Array<typeof mocks.voteMatrixPoll>,
  config?: CoreConfig,
  context?: Parameters<typeof runMatrixAction>[3],
];
function runScoped(action: Parameters<typeof runMatrixAction>[0], params: Record<string, unknown>) {
  return runMatrixAction(action, params, cfg, account);
}
const makeMessage = (eventId: string, body: string, timestamp = 1_750_000_000_000) => ({
  eventId,
  sender: "@alice:example.org",
  body,
  timestamp,
});
const readParams = {
  roomId: `room:${roomId}`,
  limit: 7,
  before: "before",
  after: "after",
  threadId: "$thread",
};

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

  it.each([
    { params: { pollOptionIndex: 1 }, error: "pollId required" },
    {
      params: { pollId: "$poll", pollOptionIndex: 1.5 },
      error: "pollOptionIndex must be a positive integer.",
    },
    {
      params: { pollId: "$poll", pollOptionIndexes: [1, 2.5] },
      error: "pollOptionIndexes must contain positive integers.",
    },
  ])("rejects invalid vote: $error", async ({ params, error }) => {
    await expect(runMatrixAction("poll-vote", { roomId, ...params }, emptyCfg)).rejects.toThrow(
      error,
    );
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

  it("passes account-scoped opts to add reactions", async () => {
    await runScoped("react", { ...target, emoji: "👍" });
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

  it("rejects custom-emote discovery when reactions are disabled", async () => {
    const params = { roomId: "!blocked:example" };
    await expect(
      runMatrixAction("emoji-list", params, {
        channels: { matrix: { actions: { reactions: false } } },
      }),
    ).rejects.toThrow("Matrix reactions are disabled.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    expect(mocks.listMatrixEmojis).not.toHaveBeenCalled();
  });

  it.each<BlockedCase>([
    ["react", { ...target, emoji: "👍" }, [mocks.reactMatrixMessage]],
    ["edit", { ...target, message: "updated" }, [mocks.editMatrixMessage]],
    ["delete", target, [mocks.deleteMatrixMessage]],
    ["poll-vote", { pollId: "$poll", pollOptionIndex: 1 }, [mocks.voteMatrixPoll], emptyCfg],
    ["emoji-list", {}, [mocks.listMatrixEmojis], emptyCfg],
    [
      "pin",
      { messageId: "$pin" },
      [mocks.pinMatrixMessage, mocks.unpinMatrixMessage, mocks.listMatrixPins],
    ],
    [
      "read",
      { messageId: "$older" },
      [mocks.readMatrixMessage, mocks.readMatrixMessages],
      emptyCfg,
      {
        ...account,
        requesterAccountId: "other",
        toolContext: { currentChannelId: "!current:example", currentChannelProvider: "matrix" },
      },
    ],
  ])(
    "rejects blocked %s before reading or mutating Matrix",
    async (action, params, forbidden, config = cfg, context = {}) => {
      blockReadTarget();
      await expect(
        runMatrixAction(action, { ...params, roomId: "!blocked:example" }, config, context),
      ).rejects.toThrow(blockedMessage);
      for (const call of forbidden) {
        expect(call).not.toHaveBeenCalled();
      }
    },
  );

  it("passes account-scoped opts to remove reactions", async () => {
    await runScoped("react", { room_id: roomId, message_id: "$msg", emoji: "👍", remove: true });
    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith(roomId, "$msg", {
      ...authorizedOpts,
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const result = await runScoped("reactions", {
      room_id: roomId,
      message_id: "$msg",
      limit: "5",
    });
    expect(mocks.listMatrixReactions).toHaveBeenCalledWith(roomId, "$msg", {
      ...authorizedOpts,
      limit: 5,
    });
    expect(result.details).toEqual({
      ok: true,
      reactions: [{ key: "👍", count: 1, users: ["@u:example"] }],
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
        threadId: "$thread",
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
      threadId: "$thread",
      audioAsVoice: true,
    });
    expect(mocks.sendMatrixMessage.mock.lastCall?.[2]?.mediaAccess).toBe(mediaAccess);
  });

  it.each([
    ["history", "$message", "hello from Matrix", 1_750_000_000_000, "2025-06-15T15:06:40.000Z"],
    ["event", "$older", "older", 1000, "1970-01-01T00:00:01.000Z"],
    ["pins", "$pin", "pinned message", 1_750_000_000_000, "2025-06-15T15:06:40.000Z"],
  ] as const)(
    "projects %s without losing source fields or selection semantics",
    async (kind, id, body, timestamp, ts) => {
      const entry = {
        ...makeMessage(id, body, timestamp),
        ...(kind === "history" ? { msgtype: "m.text" } : {}),
      };
      const projected = { ...entry, id, authorTag: "@alice:example.org", content: body, ts };
      const sparse = { eventId: "$sparse" };
      const history = { messages: [entry, sparse], nextBatch: "next", prevBatch: "previous" };
      const pins = { pinned: [id], events: [entry] };
      const provider =
        kind === "history"
          ? mocks.readMatrixMessages
          : kind === "event"
            ? mocks.readMatrixMessage
            : mocks.listMatrixPins;
      provider.mockResolvedValueOnce(
        kind === "history" ? history : kind === "event" ? entry : pins,
      );
      const params =
        kind === "pins"
          ? { roomId }
          : {
              ...readParams,
              limit: kind === "event" ? 5 : 7,
              messageId: kind === "event" ? "  $older  " : "   ",
            };
      const result = await runScoped(kind === "pins" ? "list-pins" : "read", params);
      if (kind === "history") {
        const { roomId: _room, ...pagination } = readParams;
        expect(provider).toHaveBeenCalledWith(roomId, { ...authorizedOpts, ...pagination });
        expect(mocks.readMatrixMessage).not.toHaveBeenCalled();
        expect(result.details).toEqual({
          ok: true,
          roomId,
          threadId: "$thread",
          messages: [projected, { ...sparse, id: "$sparse" }],
          nextBatch: "next",
          prevBatch: "previous",
        });
      } else if (kind === "event") {
        expect(provider).toHaveBeenCalledWith(roomId, "$older", authorizedOpts);
        expect(mocks.readMatrixMessages).not.toHaveBeenCalled();
        expect(result.details).toEqual({ ok: true, roomId, messages: [projected] });
      } else {
        expect(provider).toHaveBeenCalledWith(roomId, authorizedOpts);
        expect(result.details).toEqual({
          ok: true,
          pinned: [id],
          events: [entry],
          pins: [projected],
        });
      }
    },
  );

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

  it.each([
    { action: "pin", expected: mocks.pinMatrixMessage, expectedPinned: ["$existing", "$pin"] },
    { action: "unpin", expected: mocks.unpinMatrixMessage, expectedPinned: ["$existing"] },
  ] as const)(
    "authorizes $action before reading pinned state",
    async ({ action, expected, expectedPinned }) => {
      const result = await runScoped(action, { roomId: `room:${roomId}`, messageId: "$pin" });
      expect(expected).toHaveBeenCalledWith(roomId, "$pin", authorizedOpts);
      expect(result.details).toEqual({ ok: true, pinned: expectedPinned });
    },
  );

  it("passes account-scoped opts to member and room info actions", async () => {
    await runScoped("member-info", { userId: "@u:example", roomId });
    await runScoped("channel-info", { roomId });
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
