import { beforeEach, describe, expect, it } from "vitest";
import {
  getMatrixActionMocks,
  matrixActionResults,
  resetMatrixActionMocks,
  runMatrixAction,
} from "./tool-actions.test-support.js";
import type { CoreConfig, MatrixAccountConfig } from "./types.js";

const mocks = getMatrixActionMocks();
const emptyCfg: CoreConfig = {};
const enabledCfg: CoreConfig = {
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
const authorizedOpts = { cfg: enabledCfg, ...account, client: mocks.matrixClient };
const mediaLocalRoots = ["/tmp/openclaw-matrix-test"];
const blockedMessage = "Matrix read target is not allowed.";
type BlockedCase = [
  action: Parameters<typeof runMatrixAction>[0],
  params: Record<string, unknown>,
  forbidden: Array<typeof mocks.voteMatrixPoll>,
  config?: CoreConfig,
  context?: Parameters<typeof runMatrixAction>[3],
];
function runScoped(action: Parameters<typeof runMatrixAction>[0], params: Record<string, unknown>) {
  return runMatrixAction(action, params, enabledCfg, account);
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
    const expectedResult = structuredClone(matrixActionResults.poll);
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
    expect(result.details).toEqual({ ok: true, result: expectedResult });
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
      enabledCfg,
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
    async (action, params, forbidden, config = enabledCfg, context = {}) => {
      mocks.withAuthorizedMatrixReadTarget.mockRejectedValueOnce(new Error(blockedMessage));
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

  it("preserves indented Markdown on message edits", async () => {
    const message = "    @alice:example.org";
    await runMatrixAction("edit", { ...target, message }, enabledCfg);
    expect(mocks.editMatrixMessage.mock.lastCall?.[2]).toBe(message);
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
    const expectedResult = structuredClone(matrixActionResults.profile);
    const result = await runMatrixAction(
      "set-profile",
      {
        display_name: "Ops Bot",
        avatar_url: "mxc://example/avatar",
        path: "/tmp/avatar.jpg",
      },
      enabledCfg,
      { ...account, mediaLocalRoots, senderIsOwner: true },
    );
    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      cfg: enabledCfg,
      account: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      avatarPath: "/tmp/avatar.jpg",
      mediaLocalRoots,
    });
    expect(result.details).toEqual({ ok: true, ...expectedResult });
  });
});

describe("Matrix action composition", () => {
  beforeEach(resetMatrixActionMocks);
  const cfg: CoreConfig = {};
  const actionConfig = (actions: MatrixAccountConfig["actions"]): CoreConfig => ({
    channels: { matrix: { actions } },
  });
  const disabledActions = { messages: false, reactions: false, pins: false, memberInfo: false };
  const disabledCfg = actionConfig(disabledActions);
  const verificationParams = { operation: "verification-list" };
  const owner = { accountId: "ops", senderIsOwner: true };
  const mediaAccess = {
    localRoots: ["/tmp/matrix-composition"],
    readFile: async () => Buffer.from("fixture"),
    workspaceDir: "/tmp/matrix-composition",
  };
  const sendDefaults = {
    mediaLocalRoots: undefined,
    replyToId: undefined,
    threadId: undefined,
    audioAsVoice: undefined,
  };
  const expectError = (result: ReturnType<typeof runMatrixAction>, message: string) =>
    expect(result).rejects.toThrow(message);
  const discarded = (...keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, "discarded"] as const));

  type ActionArgs = Parameters<typeof runMatrixAction>;
  const run = (
    action: ActionArgs[0],
    params: ActionArgs[1],
    context?: ActionArgs[3],
    config = cfg,
  ) => runMatrixAction(action, params, config, context);

  it.each([
    {
      name: "public precedence and dropped fields",
      params: {
        ...discarded("content", "replyToId", "accountId", "account_id"),
        to: " room:!room:example ",
        message: "    indented",
        media: " first.png ",
        mediaUrl: "second.png",
        replyTo: "$reply",
        asVoice: false,
        audioAsVoice: true,
      },
      context: { accountId: " ops ", mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
      message: "    indented",
      options: {
        ...sendDefaults,
        mediaUrl: " first.png ",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        replyToId: "$reply",
        audioAsVoice: false,
        accountId: "ops",
      },
    },
    {
      name: "shadowed snake-case fields and private aliases",
      params: {
        ...discarded("media_url", "file_path", "replyToId", "thread_id", "accountId"),
        to: "room:!room:example",
        mediaUrl: undefined,
        filePath: "kept.png",
        threadId: undefined,
        as_voice: true,
        audio_as_voice: true,
      },
      context: undefined,
      message: undefined,
      options: { ...sendDefaults, mediaUrl: "kept.png" },
    },
    {
      name: "media-only path, voice flag and thread",
      params: {
        to: "room:!room:example",
        path: "/tmp/clip.mp3",
        asVoice: true,
        threadId: "$thread",
      },
      context: { accountId: "ops", mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
      message: undefined,
      options: {
        ...sendDefaults,
        accountId: "ops",
        mediaUrl: "/tmp/clip.mp3",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        threadId: "$thread",
        audioAsVoice: true,
      },
    },
  ])(
    "preserves send $name and optional property presence",
    async ({ params, context, message, options }) => {
      await run("send", params, context);
      const call = mocks.sendMatrixMessage.mock.lastCall;
      expect(call).toStrictEqual(["room:!room:example", message, { ...options, cfg }]);
      expect(call?.[2].mediaAccess).toBe(context?.mediaAccess);
      expect(call?.[2].cfg).toBe(cfg);
    },
  );

  it("drops public delete reasons but preserves the downstream undefined property", async () => {
    await run("delete", { roomId: "!room:example", messageId: "$message", reason: "discarded" });
    expect(mocks.deleteMatrixMessage.mock.lastCall).toStrictEqual([
      "!room:example",
      "$message",
      { reason: undefined, cfg, client: mocks.matrixClient },
    ]);
  });

  it("carries only trusted read context and retains undefined context properties", async () => {
    const params = {
      room_id: "!room:example",
      message_id: "$message",
      limit: "5",
      accountId: "untrusted",
      requesterAccountId: "untrusted",
      currentChannelId: "!untrusted:example",
      conversationReadOrigin: "untrusted",
    };
    const context: ActionArgs[3] = {
      accountId: "ops",
      requesterAccountId: "requester",
      toolContext: {
        currentChannelId: "room:!room:example",
        currentChannelProvider: "matrix",
        currentChatType: "direct",
      },
    };
    const result = await run("reactions", params, context);

    expect(mocks.withAuthorizedMatrixReadTarget.mock.lastCall?.[0].context).toStrictEqual({
      accountId: "ops",
      requesterAccountId: "requester",
      currentChannelId: "room:!room:example",
      currentChannelProvider: "matrix",
      currentChatType: "direct",
      conversationReadOrigin: undefined,
    });
    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!room:example", "$message", {
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

  it.each([
    ["send", { to: "!room:example" }, "message required"],
    ["edit", { messageId: "$m", message: "edit" }, "to required"],
    ["read", { limit: 1.5 }, "limit must be a positive integer."],
    ["pin", {}, "messageId required"],
    ["list-pins", {}, "to required"],
    ["member-info", {}, "userId required"],
  ] as const)("validates %s %j before disabled action gates: %s", async (action, params, error) => {
    await expectError(run(action, params, undefined, disabledCfg), error);
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    expect(mocks.sendMatrixMessage).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "emoji required"],
    [{ emoji: "", remove: true }, "Emoji is required to remove a Matrix reaction."],
  ] as const)("retains late reaction validation for %j: %s", async (params, enabledError) => {
    const input = { messageId: "$m", roomId: "!room:example", ...params };
    await expectError(
      run("react", input, undefined, disabledCfg),
      "Matrix reactions are disabled.",
    );
    await expectError(run("react", input), enabledError);
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
  });

  it("uses the current Matrix room only for emoji discovery and retains late whitespace errors", async () => {
    const toolContext = {
      currentChannelId: " room:!current:example ",
      currentChannelProvider: "matrix",
    };
    await run("emoji-list", { limit: 3 }, { toolContext });
    expect(mocks.listMatrixEmojis.mock.lastCall).toStrictEqual([
      "!current:example",
      { cfg, client: mocks.matrixClient, limit: 3 },
    ]);
    mocks.withAuthorizedMatrixReadTarget.mockClear();
    mocks.listMatrixEmojis.mockClear();
    const blankContext = { toolContext: { ...toolContext, currentChannelId: " " } };
    await expectError(
      run("emoji-list", {}, blankContext, disabledCfg),
      "Matrix reactions are disabled.",
    );
    await expectError(run("emoji-list", {}, blankContext), "to required");
    const foreignContext = {
      toolContext: { currentChannelId: "!foreign:example", currentChannelProvider: "slack" },
    };
    await expectError(
      run("emoji-list", { limit: 1.5 }, foreignContext),
      "Matrix emoji-list requires a roomId or current Matrix conversation.",
    );
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
    expect(mocks.listMatrixEmojis).not.toHaveBeenCalled();
  });

  it("preserves profile aliases and dropped fields at the public owner boundary", async () => {
    const params = {
      ...discarded("display_name", "avatar_url", "avatar_path", "accountId"),
      displayName: undefined,
      name: "Fallback Name",
      avatarUrl: undefined,
      avatarPath: undefined,
      path: " /tmp/kept.png ",
      filePath: "/tmp/later.png",
    };
    await run("set-profile", params, owner);
    expect(mocks.applyMatrixProfileUpdate.mock.lastCall?.[0]).toStrictEqual({
      cfg,
      account: "ops",
      displayName: "Fallback Name",
      avatarUrl: undefined,
      avatarPath: "/tmp/kept.png",
      mediaLocalRoots: undefined,
    });
  });

  it("retains owner checks and trusted account propagation for verification", async () => {
    const ownerError = "Matrix verification actions require owner access.";
    await expectError(run("permissions", verificationParams), ownerError);
    await expectError(run("permissions", verificationParams, { senderIsOwner: false }), ownerError);
    expect(mocks.listMatrixVerifications).not.toHaveBeenCalled();

    const result = await run(
      "permissions",
      { ...verificationParams, accountId: "discarded" },
      owner,
    );
    expect(mocks.listMatrixVerifications).toHaveBeenCalledWith({ cfg, accountId: "ops" });
    expect(result.details).toEqual({ ok: true, verifications: [] });
  });

  it("rejects inherited verification operations before action gating", async () => {
    const config = actionConfig({ verification: false });
    await expectError(
      run("permissions", { operation: "constructor" }, { senderIsOwner: true }, config),
      "Unsupported Matrix permissions operation: constructor.",
    );
    expect(mocks.listMatrixVerifications).not.toHaveBeenCalled();
  });

  it("rejects profile mutation without trusted owner identity before applying the profile", async () => {
    await expectError(
      run("set-profile", { displayName: "Ops Bot" }, { accountId: "ops" }),
      "Matrix profile updates require owner access.",
    );
    expect(mocks.applyMatrixProfileUpdate).not.toHaveBeenCalled();
  });
});
