// Googlechat tests cover actions plugin behavior.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachment = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());
const getGoogleChatRuntime = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
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

  it("describes only send actions when enabled accounts exist", () => {
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
      actions: ["send", "upload-file"],
    });
  });

  it("keeps the legacy reaction gate from changing account-scoped discovery", () => {
    resolveGoogleChatAccount.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      enabled: true,
      credentialSource: "service-account",
      config: {
        actions: { reactions: accountId === "work" },
      },
    }));

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({
        actions: ["send", "upload-file"],
      });
    }
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

  it.each(["react", "reactions"])(
    "rejects unsupported %s actions without provider access",
    async (action) => {
      resolveGoogleChatAccount.mockReturnValue(buildAccount());

      if (!googlechatMessageActions.handleAction) {
        throw new Error("Expected googlechatMessageActions.handleAction to be defined");
      }
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
      expect(uploadGoogleChatAttachment).not.toHaveBeenCalled();
    },
  );
});
