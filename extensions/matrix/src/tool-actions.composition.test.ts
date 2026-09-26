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

  it("keeps public send precedence, dropped fields, and optional property presence", async () => {
    const cfg = {} as CoreConfig;
    const mediaAccess = {
      localRoots: ["/tmp/matrix-composition"],
      readFile: async () => Buffer.from("fixture"),
      workspaceDir: "/tmp/matrix-composition",
    };
    await runMatrixAction(
      "send",
      {
        to: " room:!room:example ",
        message: "    indented",
        content: "discarded private content",
        media: " first.png ",
        mediaUrl: "second.png",
        replyTo: "$reply",
        replyToId: "$discarded",
        asVoice: false,
        audioAsVoice: true,
        accountId: "discarded",
        account_id: "discarded-alias",
      },
      cfg,
      { accountId: " ops ", mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
    );

    const call = mocks.sendMatrixMessage.mock.lastCall;
    expect(call?.slice(0, 2)).toEqual(["room:!room:example", "    indented"]);
    expect(call?.[2]).toStrictEqual({
      mediaUrl: " first.png ",
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      replyToId: "$reply",
      threadId: undefined,
      audioAsVoice: false,
      cfg,
      accountId: "ops",
    });
    expect(call?.[2].mediaAccess).toBe(mediaAccess);
    expect(call?.[2].cfg).toBe(cfg);
  });

  it("does not revive shadowed snake-case fields or accept private send aliases", async () => {
    const cfg = {} as CoreConfig;
    await runMatrixAction(
      "send",
      {
        to: "room:!room:example",
        mediaUrl: undefined,
        media_url: "discarded.png",
        filePath: "kept.png",
        file_path: "discarded-path.png",
        replyToId: "$discarded",
        threadId: undefined,
        thread_id: "$discarded-thread",
        as_voice: true,
        audio_as_voice: true,
        accountId: "discarded",
      },
      cfg,
    );

    expect(mocks.sendMatrixMessage.mock.lastCall).toStrictEqual([
      "room:!room:example",
      undefined,
      {
        mediaUrl: "kept.png",
        mediaLocalRoots: undefined,
        replyToId: undefined,
        threadId: undefined,
        audioAsVoice: undefined,
        cfg,
      },
    ]);
  });

  it.each([
    { name: "absent", params: { media_url: "alias.png" }, mediaUrl: "alias.png" },
    {
      name: "own undefined",
      params: { mediaUrl: undefined, media_url: "alias.png" },
      mediaUrl: undefined,
    },
    { name: "own empty", params: { mediaUrl: "", media_url: "alias.png" }, mediaUrl: undefined },
  ])(
    "preserves $name camel-case media fields before snake-case aliases",
    async ({ params, mediaUrl }) => {
      await runMatrixAction(
        "send",
        { to: "!room:example", message: "", ...params },
        {} as CoreConfig,
      );
      expect(mocks.sendMatrixMessage.mock.lastCall?.[2].mediaUrl).toBe(mediaUrl);
    },
  );

  it("drops public delete reasons but preserves the downstream undefined property", async () => {
    const cfg = {} as CoreConfig;
    await runMatrixAction(
      "delete",
      {
        roomId: "!room:example",
        messageId: "$message",
        reason: "discarded",
      },
      cfg,
    );
    expect(mocks.deleteMatrixMessage.mock.lastCall).toStrictEqual([
      "!room:example",
      "$message",
      { reason: undefined, cfg, client: mocks.matrixClient },
    ]);
  });

  it("carries only trusted read context and retains undefined context properties", async () => {
    const cfg = {} as CoreConfig;
    await runMatrixAction(
      "reactions",
      {
        roomId: "!room:example",
        messageId: "$message",
        accountId: "untrusted",
        requesterAccountId: "untrusted",
        currentChannelId: "!untrusted:example",
        conversationReadOrigin: "untrusted",
      },
      cfg,
      {
        accountId: "ops",
        requesterAccountId: "requester",
        toolContext: {
          currentChannelId: "room:!room:example",
          currentChannelProvider: "matrix",
          currentChatType: "direct",
        },
      },
    );

    expect(mocks.withAuthorizedMatrixReadTarget.mock.lastCall?.[0].context).toStrictEqual({
      accountId: "ops",
      requesterAccountId: "requester",
      currentChannelId: "room:!room:example",
      currentChannelProvider: "matrix",
      currentChatType: "direct",
      conversationReadOrigin: undefined,
    });
    expect(mocks.listMatrixReactions.mock.lastCall?.[2].accountId).toBe("ops");
  });

  it.each([
    { action: "send", params: {}, error: "to required" },
    { action: "send", params: { to: "!room:example" }, error: "message required" },
    { action: "edit", params: {}, error: "messageId required" },
    { action: "edit", params: { messageId: "$m" }, error: "message required" },
    { action: "edit", params: { messageId: "$m", message: "edit" }, error: "to required" },
    { action: "react", params: {}, error: "messageId required" },
    { action: "react", params: { messageId: "$m" }, error: "to required" },
    {
      action: "reactions",
      params: { messageId: "$m", limit: 1.5 },
      error: "limit must be a positive integer.",
    },
    { action: "read", params: { limit: 1.5 }, error: "limit must be a positive integer." },
    { action: "pin", params: {}, error: "messageId required" },
    { action: "list-pins", params: {}, error: "to required" },
    { action: "member-info", params: {}, error: "userId required" },
  ] as const)(
    "validates $action arguments before disabled action gates: $error",
    async ({ action, params, error }) => {
      const cfg = {
        channels: {
          matrix: {
            actions: {
              messages: false,
              reactions: false,
              pins: false,
              memberInfo: false,
            },
          },
        },
      } as CoreConfig;
      await expect(runMatrixAction(action, params, cfg)).rejects.toThrow(error);
      expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
      expect(mocks.sendMatrixMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { params: {}, enabledError: "emoji required" },
    {
      params: { emoji: "", remove: true },
      enabledError: "Emoji is required to remove a Matrix reaction.",
    },
  ])("retains late reaction validation: $enabledError", async ({ params, enabledError }) => {
    const input = { messageId: "$m", roomId: "!room:example", ...params };
    await expect(
      runMatrixAction("react", input, {
        channels: { matrix: { actions: { reactions: false } } },
      } as CoreConfig),
    ).rejects.toThrow("Matrix reactions are disabled.");
    await expect(runMatrixAction("react", input, {} as CoreConfig)).rejects.toThrow(enabledError);
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
  });

  it("uses the current Matrix room only for emoji discovery and retains late whitespace errors", async () => {
    const cfg = {} as CoreConfig;
    const toolContext = {
      currentChannelId: " room:!current:example ",
      currentChannelProvider: "matrix",
    };
    await runMatrixAction("emoji-list", { limit: 3 }, cfg, { toolContext });
    expect(mocks.listMatrixEmojis.mock.lastCall).toStrictEqual([
      "!current:example",
      { cfg, client: mocks.matrixClient, limit: 3 },
    ]);
    mocks.withAuthorizedMatrixReadTarget.mockClear();
    const blankContext = { toolContext: { ...toolContext, currentChannelId: " " } };
    await expect(
      runMatrixAction(
        "emoji-list",
        {},
        {
          channels: { matrix: { actions: { reactions: false } } },
        } as CoreConfig,
        blankContext,
      ),
    ).rejects.toThrow("Matrix reactions are disabled.");
    await expect(runMatrixAction("emoji-list", {}, cfg, blankContext)).rejects.toThrow(
      "to required",
    );
    await expect(
      runMatrixAction("emoji-list", { limit: 1.5 }, cfg, {
        toolContext: { currentChannelId: "!foreign:example", currentChannelProvider: "slack" },
      }),
    ).rejects.toThrow("Matrix emoji-list requires a roomId or current Matrix conversation.");
    expect(mocks.withAuthorizedMatrixReadTarget).not.toHaveBeenCalled();
  });

  it.each([
    {
      params: {
        roomId: "room:!explicit:example",
        channelId: "!later:example",
        to: "!last:example",
      },
    },
    { params: { channelId: "room:!explicit:example", to: "!last:example" } },
    { params: { to: "room:!explicit:example" } },
  ])(
    "prefers explicit emoji discovery targets over the current conversation",
    async ({ params }) => {
      await runMatrixAction("emoji-list", params, {} as CoreConfig, {
        toolContext: { currentChannelId: "!current:example", currentChannelProvider: "matrix" },
      });
      expect(mocks.listMatrixEmojis.mock.lastCall?.[0]).toBe("!explicit:example");
    },
  );

  it("preserves profile aliases and dropped fields at the public owner boundary", async () => {
    const cfg = {} as CoreConfig;
    await runMatrixAction(
      "set-profile",
      {
        displayName: undefined,
        display_name: "discarded display alias",
        name: "Fallback Name",
        avatarUrl: undefined,
        avatar_url: "mxc://example/discarded",
        avatarPath: undefined,
        avatar_path: "/tmp/discarded.png",
        path: " /tmp/kept.png ",
        filePath: "/tmp/later.png",
        accountId: "discarded",
      },
      cfg,
      { accountId: "ops", senderIsOwner: true },
    );
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
    const cfg = {} as CoreConfig;
    await expect(
      runMatrixAction(
        "permissions",
        {
          operation: "verification-list",
        },
        cfg,
      ),
    ).rejects.toThrow("Matrix verification actions require owner access.");
    await expect(
      runMatrixAction("permissions", { operation: "verification-list" }, cfg, {
        senderIsOwner: false,
      }),
    ).rejects.toThrow("Matrix verification actions require owner access.");
    expect(mocks.listMatrixVerifications).not.toHaveBeenCalled();

    const result = await runMatrixAction(
      "permissions",
      {
        operation: "verification-list",
        accountId: "discarded",
      },
      cfg,
      { accountId: "ops", senderIsOwner: true },
    );
    expect(mocks.listMatrixVerifications).toHaveBeenCalledWith({ cfg, accountId: "ops" });
    expect(result.details).toEqual({ ok: true, verifications: [] });
  });

  it.each(["invalid", "constructor", "__proto__"])(
    "rejects unsupported verification operation %s before action gating",
    async (operation) => {
      await expect(
        runMatrixAction(
          "permissions",
          { operation },
          {
            channels: { matrix: { actions: { verification: false } } },
          } as CoreConfig,
          { senderIsOwner: true },
        ),
      ).rejects.toThrow(`Unsupported Matrix permissions operation: ${operation}.`);
      expect(mocks.listMatrixVerifications).not.toHaveBeenCalled();
    },
  );

  it("rejects profile mutation without trusted owner identity before applying the profile", async () => {
    await expect(
      runMatrixAction("set-profile", { displayName: "Ops Bot" }, {} as CoreConfig, {
        accountId: "ops",
      }),
    ).rejects.toThrow("Matrix profile updates require owner access.");
    expect(mocks.applyMatrixProfileUpdate).not.toHaveBeenCalled();
  });
});
