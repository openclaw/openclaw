import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./message-tool-api.js"));
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

  function buildAccount() {
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      config: { groupPolicy: "open", dmPolicy: "open" },
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
      actions: ["send"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("keeps account-scoped discovery send-only", () => {
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
        actions: ["send"],
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

  it.each([
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrls: ["remote.png"] },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ url: "remote.png" }],
      },
    },
  ])(
    "rejects outbound attachment action $action before provider access",
    async ({ action, params }) => {
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params,
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow("Google Chat outbound attachments require remote HTTP(S) URLs.");

      expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
      expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported actions without provider access", async () => {
    const action = "react";
    resolveGoogleChatAccount.mockReturnValue(buildAccount());

    await expect(
      googlechatMessageActions.handleAction({
        action,
        params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, "caption"])("sends remote media with caption %s", async (message) => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    await googlechatMessageActions.handleAction({
      action: "send",
      params: { to: "spaces/AAA", message, media: "https://example.invalid/image.png" },
      cfg: {},
    } as never);
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: `${message ? "caption\n\n" : ""}Attachment: https://example.invalid/image.png`,
      }),
    );
  });
  it.each([undefined, "spaces/AAA/threads/fallback"])(
    "chunks remote captions through the registered action in returned thread %s",
    async (returnedThread) => {
      const account = { ...buildAccount(), config: { textChunkLimit: 64 } };
      resolveGoogleChatAccount.mockReturnValue(account);
      resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
      sendGoogleChatMessage.mockResolvedValue({
        messageName: "spaces/AAA/messages/chunk",
        threadName: returnedThread,
      });
      await googlechatMessageActions.handleAction({
        action: "send",
        params: {
          to: "spaces/AAA",
          message: "a".repeat(55),
          attachments: [{ url: "https://example.invalid/image.png" }],
          threadId: "spaces/AAA/threads/root",
        },
        cfg: {},
      } as never);
      const texts = sendGoogleChatMessage.mock.calls.map(([request]) => request.text.trim());
      expect(texts).toEqual(["a".repeat(55), "Attachment: https://example.invalid/image.png"]);
      for (const [index, [request]] of sendGoogleChatMessage.mock.calls.entries()) {
        expect(request.thread).toBe(
          index === 0 ? "spaces/AAA/threads/root" : (returnedThread ?? "spaces/AAA/threads/root"),
        );
        expect(Buffer.byteLength(request.text)).toBeLessThanOrEqual(64);
      }
    },
  );

  it.each([false, true])(
    "preserves accepted action chunks before failure: accepted=%s",
    async (accepted) => {
      const failure = new Error("provider rejected chunk");
      resolveGoogleChatAccount.mockReturnValue({
        ...buildAccount(),
        config: { textChunkLimit: 64 },
      });
      resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
      sendGoogleChatMessage.mockReset().mockRejectedValue(failure);
      if (accepted) {
        sendGoogleChatMessage.mockResolvedValueOnce({ messageName: "spaces/AAA/messages/caption" });
      }
      await expect(
        googlechatMessageActions.handleAction({
          action: "send",
          params: {
            to: "spaces/AAA",
            message: "a".repeat(55),
            mediaUrl: "https://example.invalid/image.png",
          },
          cfg: {},
        } as never),
      ).rejects.toSatisfy((error: unknown) =>
        accepted
          ? isChannelPartialDeliveryError(error) &&
            error.cause === failure &&
            error.deliveryResult.messageIds?.join(",") === "spaces/AAA/messages/caption" &&
            error.deliveryResult.content?.trim() === "a".repeat(55) &&
            error.deliveryResult.visibleReplySent
          : error === failure,
      );
      expect(sendGoogleChatMessage).toHaveBeenCalledTimes(accepted ? 2 : 1);
    },
  );

  it("still rejects native upload before resolving credentials", async () => {
    await expect(
      googlechatMessageActions.handleAction({
        action: "upload-file",
        params: { path: "/tmp/local.png" },
        cfg: {},
      } as never),
    ).rejects.toThrow("require user OAuth");
    expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
  });
});
