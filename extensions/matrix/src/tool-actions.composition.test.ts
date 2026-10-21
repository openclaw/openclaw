import { beforeEach, expect, it } from "vitest";
import {
  getMatrixActionMocks,
  resetMatrixActionMocks,
  runMatrixAction,
} from "./tool-actions.test-support.js";
import type { CoreConfig, MatrixAccountConfig } from "./types.js";

const mocks = getMatrixActionMocks();
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
const run = (action: ActionArgs[0], params: ActionArgs[1], context?: ActionArgs[3], config = cfg) =>
  runMatrixAction(action, params, config, context);

beforeEach(resetMatrixActionMocks);

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
    roomId: "!room:example",
    messageId: "$message",
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
  await run("reactions", params, context);

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
  await expectError(run("react", input, undefined, disabledCfg), "Matrix reactions are disabled.");
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

  const result = await run("permissions", { ...verificationParams, accountId: "discarded" }, owner);
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
