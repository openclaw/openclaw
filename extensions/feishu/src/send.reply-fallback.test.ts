// Feishu tests cover send.reply fallback plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

import { withFeishuSendContext } from "./send-context.js";

let sendCardFeishu: typeof import("./send.js").sendCardFeishu;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

describe("Feishu reply fallback for withdrawn/deleted targets", () => {
  const replyMock = vi.fn();
  const createMock = vi.fn();

  async function expectFallbackResult(
    send: () => Promise<{ messageId?: string; receipt?: { replyToId?: string } }>,
    expectedMessageId: string,
  ) {
    const result = await send();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe(expectedMessageId);
    expect(result.receipt?.replyToId).toBeUndefined();
    expect(createMock.mock.calls[0]?.[0]?.data?.uuid).not.toBe(
      replyMock.mock.calls[0]?.[0]?.data?.uuid,
    );
  }

  beforeAll(async () => {
    ({ sendCardFeishu, sendMessageFeishu } = await import("./send.js"));
  });

  afterAll(() => {
    vi.doUnmock("./send-target.js");
    vi.resetModules();
  });

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.resetAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "ou_target",
      receiveIdType: "open_id",
    });
  });

  it.each([false, true])(
    "replays an accepted message after a lost response (reply=%s)",
    async (reply) => {
      vi.useFakeTimers();
      const sent = new Map<string, string>();
      const requests: string[] = [];
      const sender = reply ? replyMock : createMock;
      sender.mockImplementation(async ({ data }: { data: { uuid: string } }) => {
        requests.push(data.uuid);
        if (!sent.has(data.uuid)) {
          sent.set(data.uuid, "om_accepted");
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return { code: 0, data: { message_id: sent.get(data.uuid) } };
      });
      const result = sendMessageFeishu({
        cfg: {},
        to: "user:ou_target",
        text: "hello",
        ...(reply ? { replyToMessageId: "om_parent", replyInThread: true } : {}),
      });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({ messageId: "om_accepted" });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(requests[1]).toBe(requests[0]);
      expect(sent.size).toBe(1);
      if (reply) {
        expect(sender.mock.calls[1]?.[0]?.data?.reply_in_thread).toBe(true);
      }
    },
  );

  it("stops dispatch immediately when the sender is cancelled during backoff", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    createMock.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    const result = withFeishuSendContext({ signal: abort.signal }, () =>
      sendMessageFeishu({ cfg: {}, to: "user:ou_target", text: "hello" }),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(createMock).toHaveBeenCalledOnce();
    abort.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeInstanceOf(Error);
    expect(createMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves Feishu diagnostics when direct sends reject before response checks", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 9499,
          msg: "Bad Request",
          error: {
            log_id: "202604291247104BEF4C42D2420A9AD569",
            troubleshooter:
              "https://open.feishu.cn/search?log_id=202604291247104BEF4C42D2420A9AD569",
          },
        },
      },
    });
    createMock.mockRejectedValue(apiError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "user:ou_target",
        text: "hello",
      }),
    ).rejects.toThrow(
      /Feishu send failed: .*"http_status":400.*"feishu_code":9499.*"feishu_msg":"Bad Request".*"feishu_log_id":"202604291247104BEF4C42D2420A9AD569".*"feishu_troubleshooter":"https:\/\/open\.feishu\.cn\/search\?log_id=202604291247104BEF4C42D2420A9AD569"/,
    );
  });

  it("never duplicates an accepted reply with a missing platform id", async () => {
    replyMock.mockResolvedValueOnce({ code: 0, data: {} });
    let caught: unknown;
    try {
      await sendMessageFeishu({
        cfg: {},
        to: "user:ou_target",
        text: "hello",
        replyToMessageId: "om_parent",
      });
    } catch (error) {
      caught = error;
    }
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!(caught instanceof Error) || !isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted Feishu reply without an identity");
    }
    expect(caught.message).toBe("Feishu reply failed: no message_id returned");
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(replyMock).toHaveBeenCalledOnce();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to create when reply throws a withdrawn SDK error", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thrown_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
        }),
      "om_thrown_fallback",
    );
  });

  it("falls back to create when card reply throws a not-found AxiosError", async () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      response: { status: 200, data: { code: 231003, msg: "The message is not found" } },
    });
    replyMock.mockRejectedValue(axiosError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_axios_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          card: { schema: "2.0" },
          replyToMessageId: "om_parent",
        }),
      "om_axios_fallback",
    );
  });

  it("falls back to a top-level group send when normal quoted replies target withdrawn messages", async () => {
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      },
      receiveId: "oc_group_1",
      receiveIdType: "chat_id",
    });
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_group_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "chat:oc_group_1",
          text: "hello",
          replyToMessageId: "om_parent",
          replyInThread: true,
          allowTopLevelReplyFallback: true,
        }),
      "om_group_fallback",
    );

    expect(replyMock).toHaveBeenCalledWith({
      path: { message_id: "om_parent" },
      data: {
        content: '{"zh_cn":{"content":[[{"tag":"md","text":"hello"}]]}}',
        msg_type: "post",
        uuid: expect.any(String),
        reply_in_thread: true,
      },
    });
    expect(createMock).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        content: '{"zh_cn":{"content":[[{"tag":"md","text":"hello"}]]}}',
        receive_id: "oc_group_1",
        msg_type: "post",
        uuid: expect.any(String),
      },
    });
  });

  it("fails native thread replies instead of falling back to a top-level send", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves the reply anchor after a successful native thread reply", async () => {
    replyMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thread_reply" },
    });

    const result = await sendMessageFeishu({
      cfg: {} as never,
      to: "chat:oc_group_1",
      text: "hello",
      replyToMessageId: "om_parent",
      replyInThread: true,
    });

    expect(result.receipt.replyToId).toBe("om_parent");
    expect(result.receipt.threadId).toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("fails thrown withdrawn native thread replies instead of falling back to create", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230011 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves non-withdrawn thread reply failures", async () => {
    replyMock.mockResolvedValue({
      code: 999999,
      msg: "unknown failure",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
        allowTopLevelReplyFallback: true,
      }),
    ).rejects.toThrow("Feishu reply failed");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves thrown non-withdrawn thread reply failures", async () => {
    const sdkError = Object.assign(new Error("rate limited"), { code: 99991400 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        to: "chat:oc_group_1",
        text: "hello",
        replyToMessageId: "om_parent",
        replyInThread: true,
        allowTopLevelReplyFallback: true,
      }),
    ).rejects.toThrow("rate limited");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("still falls back for non-thread replies to withdrawn targets", async () => {
    replyMock.mockResolvedValue({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_non_thread_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          to: "user:ou_target",
          text: "hello",
          replyToMessageId: "om_parent",
          replyInThread: false,
        }),
      "om_non_thread_fallback",
    );
  });
});
