// Googlechat tests cover actions plugin behavior.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const createGoogleChatReaction = vi.hoisted(() => vi.fn());
const deleteGoogleChatReaction = vi.hoisted(() => vi.fn());
const listGoogleChatReactions = vi.hoisted(() => vi.fn());
const findGoogleChatDirectMessage = vi.hoisted(() => vi.fn());
const getGoogleChatSpace = vi.hoisted(() => vi.fn());
const getGoogleChatSpaceMembership = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachment = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());
const getGoogleChatRuntime = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  findGoogleChatDirectMessage,
  getGoogleChatSpace,
  getGoogleChatSpaceMembership,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime,
}));

vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./actions.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./actions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getGoogleChatSpace.mockResolvedValue(null);
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function buildAccount(overrides: Record<string, unknown> = {}) {
    const overrideConfig =
      overrides.config && typeof overrides.config === "object"
        ? (overrides.config as Record<string, unknown>)
        : {};
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      ...overrides,
      config: {
        groupPolicy: "open",
        dm: { policy: "open" },
        ...overrideConfig,
      },
    };
  }

  function expectJsonResult(result: unknown, details: Record<string, unknown>) {
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(details, null, 2),
        },
      ],
      details,
    });
  }

  it("describes send and reaction actions only when enabled accounts exist", () => {
    listEnabledGoogleChatAccounts.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listEnabledGoogleChatAccounts.mockReturnValueOnce([
      {
        enabled: true,
        credentialSource: "service-account",
        config: { actions: { reactions: true } },
      },
    ]);

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("honors account-scoped reaction gates during discovery", () => {
    resolveGoogleChatAccount.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      enabled: true,
      credentialSource: "service-account",
      config: {
        actions: { reactions: accountId === "work" },
      },
    }));

    expect(
      googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId: "default" }),
    ).toEqual({
      actions: ["send", "upload-file"],
    });
    expect(
      googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId: "work" }),
    ).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("sends messages with uploaded media through the resolved space", async () => {
    const account = buildAccount({
      config: { mediaMaxMb: 5 },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    const readRemoteMediaBuffer = vi.fn(async () => ({
      buffer: Buffer.from("remote-bytes"),
      fileName: "remote.png",
      contentType: "image/png",
    }));
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          readRemoteMediaBuffer,
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        media: "https://example.com/file.png",
        threadId: "thread-1",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(readRemoteMediaBuffer).toHaveBeenCalledWith({
      url: "https://example.com/file.png",
      maxBytes: 5 * 1024 * 1024,
    });
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      filename: "remote.png",
      buffer: Buffer.from("remote-bytes"),
      contentType: "image/png",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
      attachments: [{ attachmentUploadToken: "token-1", contentName: "remote.png" }],
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
  });

  it("routes upload-file through the same attachment upload path with filename override", async () => {
    const account = buildAccount({
      config: { mediaMaxMb: 5 },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/BBB");
    const localRoot = "/tmp/googlechat-action-test";
    const localPath = path.join(localRoot, "local.md");
    const readFile = vi.fn(async () => Buffer.from("local-bytes"));
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          readRemoteMediaBuffer: vi.fn(),
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/BBB/messages/msg-2",
      threadName: "spaces/BBB/threads/thread-2",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "upload-file",
      params: {
        to: "spaces/BBB",
        path: localPath,
        message: "notes",
        filename: "renamed.txt",
      },
      cfg: {},
      accountId: "default",
      mediaLocalRoots: [localRoot],
      mediaReadFile: readFile,
    } as never);

    expect(readFile).toHaveBeenCalledWith(localPath);
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith({
      account,
      space: "spaces/BBB",
      filename: "renamed.txt",
      buffer: Buffer.from("local-bytes"),
      contentType: "text/markdown",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/BBB",
      text: "notes",
      thread: undefined,
      attachments: [{ attachmentUploadToken: "token-2", contentName: "renamed.txt" }],
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/BBB",
      messageName: "spaces/BBB/messages/msg-2",
      threadName: "spaces/BBB/threads/thread-2",
    });
  });

  it("removes only matching app reactions on react remove", async () => {
    const account = buildAccount({
      config: { botUser: "users/app-bot" },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    listGoogleChatReactions.mockResolvedValue([
      {
        name: "reactions/1",
        emoji: { unicode: "👍" },
        user: { name: "users/app" },
      },
      {
        name: "reactions/2",
        emoji: { unicode: "👍" },
        user: { name: "users/app-bot" },
      },
      {
        name: "reactions/3",
        emoji: { unicode: "👍" },
        user: { name: "users/other" },
      },
    ]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "react",
      params: {
        messageId: "spaces/AAA/messages/msg-1",
        emoji: "👍",
        remove: true,
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/msg-1",
    });
    expect(deleteGoogleChatReaction).toHaveBeenCalledTimes(2);
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(1, {
      account,
      reactionName: "reactions/1",
    });
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(2, {
      account,
      reactionName: "reactions/2",
    });
    expectJsonResult(result, { ok: true, removed: 2 });
  });

  it("rejects fractional reaction limits before listing reactions", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: {
          messageId: "spaces/AAA/messages/msg-1",
          limit: 2.5,
        },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("limit must be a positive integer");

    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("allows reads from the trusted current Google Chat space", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "allowlist",
        dm: { policy: "pairing" },
        groups: {},
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "GROUP_CHAT" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: {
        messageId: "spaces/CURRENT/messages/msg-1",
      },
      cfg: {},
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "googlechat",
        currentChannelId: "spaces/CURRENT",
      },
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CURRENT/messages/msg-1",
      limit: undefined,
    });
  });

  it("rejects reaction reads outside configured spaces before calling Google Chat", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "allowlist",
        dm: { policy: "allowlist", allowFrom: [] },
        groups: {
          "spaces/ALLOWED": {},
        },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "GROUP_CHAT" });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "react",
        params: {
          messageId: "spaces/BLOCKED/messages/msg-1",
          emoji: "",
        },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("preserves an exact disabled-space denial when space lookup fails", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { policy: "open", allowFrom: ["*"] },
        groups: {
          "spaces/BLOCKED": { enabled: false },
        },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockRejectedValue(new Error("lookup unavailable"));

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: {
          messageId: "spaces/BLOCKED/messages/msg-1",
        },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");

    expect(getGoogleChatSpace).not.toHaveBeenCalled();
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("preserves a wildcard disabled-space denial when space lookup fails", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { policy: "open", allowFrom: ["*"] },
        groups: {
          "*": { enabled: false },
        },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockRejectedValue(new Error("lookup unavailable"));

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: {
          messageId: "spaces/BLOCKED/messages/msg-1",
        },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");

    expect(getGoogleChatSpace).toHaveBeenCalledOnce();
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("rejects non-canonical message resource paths before calling Google Chat", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { policy: "open", allowFrom: ["*"] },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: {
          messageId: "spaces/ALLOWED/messages/x/../../spaces/BLOCKED/messages/y",
        },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat message target is invalid.");
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("allows an API-confirmed direct space when direct messages are open", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "allowlist",
        dm: { policy: "open", allowFrom: ["*"] },
        groups: {},
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "DIRECT_MESSAGE" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: { messageId: "spaces/DM/messages/msg-1" },
      cfg: {},
      accountId: "default",
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledOnce();
  });

  it("keeps wildcard group denials independent from API-confirmed direct spaces", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { policy: "open", allowFrom: ["*"] },
        groups: {
          "*": { enabled: false },
        },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "DIRECT_MESSAGE" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: { messageId: "spaces/DM/messages/msg-1" },
      cfg: {},
      accountId: "default",
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledOnce();
  });

  it("does not classify a configured direct space as a group", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { enabled: false, policy: "disabled", allowFrom: [] },
        groups: {
          "spaces/DM": {},
        },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "DIRECT_MESSAGE" });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: { messageId: "spaces/DM/messages/msg-1" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");

    expect(getGoogleChatSpace).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
    });
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("allows an opted-in raw email only for its API-confirmed direct space", async () => {
    const account = buildAccount({
      config: {
        dangerouslyAllowNameMatching: true,
        groupPolicy: "allowlist",
        dm: { policy: "allowlist", allowFrom: ["alice@example.com"] },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpaceMembership.mockResolvedValue({
      name: "spaces/DM/members/123",
      member: { name: "users/123" },
    });
    getGoogleChatSpace.mockResolvedValue({ spaceType: "DIRECT_MESSAGE" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: { messageId: "spaces/DM/messages/msg-1" },
      cfg: {},
      accountId: "default",
    } as never);

    expect(getGoogleChatSpaceMembership).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      member: "alice@example.com",
    });
    expect(findGoogleChatDirectMessage).not.toHaveBeenCalled();
    expect(listGoogleChatReactions).toHaveBeenCalledOnce();
  });

  it("does not treat an opted-in raw email membership in a group as a DM allowlist match", async () => {
    const account = buildAccount({
      config: {
        dangerouslyAllowNameMatching: true,
        groupPolicy: "allowlist",
        dm: { policy: "allowlist", allowFrom: ["alice@example.com"] },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpaceMembership.mockResolvedValue({
      name: "spaces/GROUP/members/123",
      member: { name: "users/123" },
    });
    getGoogleChatSpace.mockResolvedValue({ spaceType: "GROUP_CHAT" });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: { messageId: "spaces/GROUP/messages/msg-1" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });

  it("allows an API-confirmed group space when groups are open", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "open",
        dm: { policy: "allowlist", allowFrom: [] },
        groups: {},
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "SPACE" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: { messageId: "spaces/GROUP/messages/msg-1" },
      cfg: {},
      accountId: "default",
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledOnce();
  });

  it("allows an API-confirmed group space admitted by wildcard config", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "allowlist",
        dm: { policy: "allowlist", allowFrom: [] },
        groups: { "*": { requireMention: false } },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "GROUP_CHAT" });
    listGoogleChatReactions.mockResolvedValue([]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "reactions",
      params: { messageId: "spaces/WILDCARD/messages/msg-1" },
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    } as never);

    expect(listGoogleChatReactions).toHaveBeenCalledOnce();
  });

  it("does not treat per-DM history config as read authorization", async () => {
    const account = buildAccount({
      config: {
        groupPolicy: "allowlist",
        dm: { policy: "allowlist", allowFrom: [] },
        dms: { "users/alice": { historyLimit: 5 } },
      },
    });
    resolveGoogleChatAccount.mockReturnValue(account);
    getGoogleChatSpace.mockResolvedValue({ spaceType: "DIRECT_MESSAGE" });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await expect(
      googlechatMessageActions.handleAction({
        action: "reactions",
        params: { messageId: "spaces/DM/messages/msg-1" },
        cfg: { channels: { googlechat: {} } },
        accountId: "default",
      } as never),
    ).rejects.toThrow("Google Chat read target is not allowed.");
    expect(listGoogleChatReactions).not.toHaveBeenCalled();
  });
});
