import { beforeEach, describe, expect, it } from "vitest";
import {
  getMatrixActionMocks,
  resetMatrixActionMocks,
  runMatrixAction,
} from "./tool-actions.test-support.js";
import type { CoreConfig } from "./types.js";

const mocks = getMatrixActionMocks();
const cfg: CoreConfig = {};
const disabledCfg: CoreConfig = {
  channels: {
    matrix: { actions: { messages: false, reactions: false, pins: false, memberInfo: false } },
  },
};
const verificationParams = { operation: "verification-list" };
const owner = { accountId: "ops", senderIsOwner: true };
const expectError = (result: ReturnType<typeof runMatrixAction>, message: string) =>
  expect(result).rejects.toThrow(message);

function run(
  action: Parameters<typeof runMatrixAction>[0],
  params: Record<string, unknown>,
  context?: Parameters<typeof runMatrixAction>[3],
  config = cfg,
) {
  return runMatrixAction(action, params, config, context);
}

describe("Matrix public message actions", () => {
  beforeEach(resetMatrixActionMocks);

  it("keeps public send precedence, dropped fields, and optional property presence", async () => {
    const mediaAccess = {
      localRoots: ["/tmp/matrix-composition"],
      readFile: async () => Buffer.from("fixture"),
      workspaceDir: "/tmp/matrix-composition",
    };
    await run(
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
    await run("send", {
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
    });

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

  it("drops public delete reasons but preserves the downstream undefined property", async () => {
    await run("delete", { roomId: "!room:example", messageId: "$message", reason: "discarded" });
    expect(mocks.deleteMatrixMessage.mock.lastCall).toStrictEqual([
      "!room:example",
      "$message",
      { reason: undefined, cfg, client: mocks.matrixClient },
    ]);
  });

  it("carries only trusted read context and retains undefined context properties", async () => {
    await run(
      "reactions",
      {
        roomId: "!room:example",
        messageId: "$message",
        accountId: "untrusted",
        requesterAccountId: "untrusted",
        currentChannelId: "!untrusted:example",
        conversationReadOrigin: "untrusted",
      },
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
    { action: "send", params: { to: "!room:example" }, error: "message required" },
    { action: "edit", params: { messageId: "$m", message: "edit" }, error: "to required" },
    { action: "read", params: { limit: 1.5 }, error: "limit must be a positive integer." },
    { action: "pin", params: {}, error: "messageId required" },
    { action: "list-pins", params: {}, error: "to required" },
    { action: "member-info", params: {}, error: "userId required" },
  ] as const)(
    "validates $action arguments before disabled action gates: $error",
    async ({ action, params, error }) => {
      await expectError(run(action, params, undefined, disabledCfg), error);
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
  });

  it("preserves profile aliases and dropped fields at the public owner boundary", async () => {
    await run(
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
      owner,
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
    const operation = "constructor";
    await expectError(
      run(
        "permissions",
        { operation },
        { senderIsOwner: true },
        { channels: { matrix: { actions: { verification: false } } } },
      ),
      `Unsupported Matrix permissions operation: ${operation}.`,
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
