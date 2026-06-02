import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const createGoogleChatReaction = vi.hoisted(() => vi.fn());
const deleteGoogleChatReaction = vi.hoisted(() => vi.fn());
const listGoogleChatReactions = vi.hoisted(() => vi.fn());
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
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./actions.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./actions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function buildAccount(overrides: Record<string, unknown> = {}) {
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      config: {},
      ...overrides,
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
    expectJsonResult(result, { ok: true, to: "spaces/AAA" });
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
    expectJsonResult(result, { ok: true, to: "spaces/BBB" });
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

  it("falls back to a text link when remote media upload hits an app-auth 403 (#89430)", async () => {
    const account = buildAccount({ config: { mediaMaxMb: 5 } });
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    const readRemoteMediaBuffer = vi.fn(async () => ({
      buffer: Buffer.from("remote-bytes"),
      fileName: "remote.png",
      contentType: "image/png",
    }));
    getGoogleChatRuntime.mockReturnValue({
      channel: { media: { readRemoteMediaBuffer } },
    });
    uploadGoogleChatAttachment.mockRejectedValue(
      new Error(
        'Google Chat upload 403: {"error":{"status":"PERMISSION_DENIED","message":"Request had insufficient authentication scopes."}}',
      ),
    );
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/link" });

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

    // The public URL is delivered as plain text instead of throwing, so the reply is not lost.
    expect(sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption\nhttps://example.com/file.png",
      thread: "thread-1",
    });
    expect(sendGoogleChatMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
    );
    expectJsonResult(result, { ok: true, to: "spaces/AAA", mediaDelivery: "link-fallback" });
  });

  it("does not fall back for a local-file upload failure (no public URL to link) (#89430)", async () => {
    const account = buildAccount({ config: { mediaMaxMb: 5 } });
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/BBB");
    const localRoot = "/tmp/googlechat-action-test";
    const localPath = path.join(localRoot, "local.md");
    const readFile = vi.fn(async () => Buffer.from("local-bytes"));
    getGoogleChatRuntime.mockReturnValue({
      channel: { media: { readRemoteMediaBuffer: vi.fn() } },
    });
    uploadGoogleChatAttachment.mockRejectedValue(
      new Error("Google Chat upload 403: PERMISSION_DENIED"),
    );

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    // A local file has no public URL to fall back to, so the auth failure must still surface.
    await expect(
      googlechatMessageActions.handleAction({
        action: "upload-file",
        params: { to: "spaces/BBB", path: localPath, message: "notes" },
        cfg: {},
        accountId: "default",
        mediaLocalRoots: [localRoot],
        mediaReadFile: readFile,
      } as never),
    ).rejects.toThrow("Google Chat upload 403");
    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
