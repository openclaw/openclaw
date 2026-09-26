// Googlechat tests cover actions plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const updateGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
  updateGoogleChatMessage,
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
        dmPolicy: "open",
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

  it("describes send and edit actions when enabled accounts exist", () => {
    listGoogleChatAccountIds.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "inline",
      tokenStatus: "available",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send", "edit"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("does not expose actions for configured-unavailable file credentials", () => {
    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "file",
      tokenStatus: "configured_unavailable",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();
  });

  it("keeps account-scoped discovery consistent", () => {
    inspectGoogleChatAccount.mockImplementation(
      ({ accountId: _accountId }: { accountId?: string | null }) => ({
        enabled: true,
        credentialSource: "inline",
        tokenStatus: "available",
        config: {},
      }),
    );

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({
        actions: ["send", "edit"],
      });
    }
  });

  it("sends text through the resolved space", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
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
        threadId: "thread-1",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
  });

  it("edits with the selected account and the resolved DM space", async () => {
    const account = buildAccount({ accountId: "work" });
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    updateGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg.1" });

    const result = await googlechatMessageActions.handleAction!({
      channel: "googlechat",
      action: "edit",
      params: { to: "users/123", messageId: "spaces/AAA/messages/msg.1", message: "  corrected" },
      cfg: {},
      accountId: "work",
    });

    expect(resolveGoogleChatAccount).toHaveBeenCalledWith({ cfg: {}, accountId: "work" });
    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({ account, target: "users/123" });
    expect(updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/msg.1",
      text: "  corrected",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg.1",
    });
  });

  it.each([
    "msg-1",
    "spaces/AAA/messages/..",
    "spaces/AAA/messages/msg/extra",
    "spaces/AAA/messages/msg?updateMask=cardsV2",
    "spaces/AAA/messages/msg#fragment",
    "spaces/AAA/messages/%2e%2e",
  ])("rejects malformed edit resource %s before provider access", async (messageId) => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    await expect(
      googlechatMessageActions.handleAction!({
        channel: "googlechat",
        action: "edit",
        params: { to: "spaces/AAA", messageId, message: "corrected" },
        cfg: {},
      }),
    ).rejects.toThrow("messageId must be a Google Chat resource name");
    expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
    expect(updateGoogleChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    { overrides: { enabled: false }, error: "Google Chat account is disabled" },
    { overrides: { credentialSource: "none" }, error: "Google Chat credentials are missing" },
    {
      overrides: { tokenStatus: "configured_unavailable" },
      error: "Google Chat credentials are missing",
    },
  ])("rejects edits for unavailable accounts: $error", async ({ overrides, error }) => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount(overrides));
    await expect(
      googlechatMessageActions.handleAction!({
        channel: "googlechat",
        action: "edit",
        params: { to: "spaces/AAA", messageId: "spaces/AAA/messages/msg-1", message: "corrected" },
        cfg: {},
      }),
    ).rejects.toThrow(error);
    expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
    expect(updateGoogleChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrl: "remote.png" },
    },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrls: ["remote.png"] },
    },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", fileUrl: "remote.png" },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ url: "remote.png" }],
      },
    },
    {
      action: "upload-file",
      params: { to: "spaces/AAA", message: "caption", path: "local.png" },
    },
  ])(
    "rejects outbound attachment action $action before provider access",
    async ({ action, params }) => {
      if (!googlechatMessageActions.handleAction) {
        throw new Error("Expected googlechatMessageActions.handleAction to be defined");
      }
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params,
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow(
        "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
      );

      expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
      expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

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
    },
  );
});
