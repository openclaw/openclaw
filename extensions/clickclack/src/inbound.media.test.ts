import { afterEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundAgentAccount,
  createInboundAccountConfig,
  createInboundAuthor,
  createInboundMessage,
  createInboundRuntime,
  publishInboundAccountConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({ sendClickClackText: sendClickClackTextMock }));

function prepare(account = createInboundAgentAccount()) {
  const runtime = createInboundRuntime(true);
  setClickClackRuntime(runtime);
  publishInboundAccountConfig(runtime, account);
  return { runtime, account, config: createInboundAccountConfig(account) };
}

function createMediaMessage(
  uploadId: string,
  byteSize: number,
  overrides: Partial<ClickClackMessage> = {},
): ClickClackMessage {
  return createInboundMessage({
    channel_id: undefined,
    direct_conversation_id: "dm_media",
    body: "inspect this plan",
    attachments: [
      {
        id: uploadId,
        workspace_id: "wsp_1",
        owner_id: "usr_owner",
        filename: "floor-plan.png",
        content_type: "image/png",
        byte_size: byteSize,
        width: 100,
        height: 80,
        duration_ms: 0,
        created_at: "2026-05-09T12:00:00.000Z",
      },
    ],
    ...overrides,
  });
}

function stubUploadResponse(status = 200) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(status === 200 ? new Uint8Array([1, 2, 3]) : "upload unavailable", {
        status,
        headers: { "Content-Type": status === 200 ? "image/png" : "text/plain" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ClickClack inbound media", () => {
  afterEach(() => {
    sendClickClackTextMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("downloads authenticated attachments and preserves their order in the agent input", async () => {
    const { runtime, account, config } = prepare();
    const fetchMock = stubUploadResponse();
    const message = createMediaMessage("upl_plan", 3);
    const firstAttachment = message.attachments?.[0];
    if (!firstAttachment) throw new Error("missing synthetic attachment");
    message.attachments = [
      firstAttachment,
      { ...firstAttachment, id: "upl_second", filename: "second.png" },
    ];
    const consumedBytes: number[][] = [];
    vi.mocked(runtime.channel.media.saveResponseMedia).mockImplementation(async (response) => {
      consumedBytes.push([...new Uint8Array(await response.arrayBuffer())]);
      return {
        id: "media",
        path: `/managed/${consumedBytes.length}.png`,
        size: 3,
        contentType: "image/png",
      };
    });

    await handleClickClackInbound({ account, config, message, correlationId: "fakeco.media_1" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8080/api/uploads/upl_plan",
      "http://127.0.0.1:8080/api/uploads/upl_second",
    ]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token-placeholder");
    expect(new Headers(init?.headers).get("X-Correlation-ID")).toBe("fakeco.media_1");
    expect(init?.redirect).toBe("error");
    expect(consumedBytes).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].ctxPayload.media).toEqual(
      [
        { path: "/managed/1.png", contentType: "image/png", messageId: "msg_1" },
        { path: "/managed/2.png", contentType: "image/png", messageId: "msg_1" },
      ],
    );
  });

  it("keeps attachment messages in text-only model mode from gaining agent or tool authority", async () => {
    const { runtime, account, config } = prepare(createInboundAgentAccount({ replyMode: "model" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleClickClackInbound({ account, config, message: createMediaMessage("upl_model", 3) });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendClickClackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "This ClickClack bot is configured for text-only model replies and cannot process attachments.",
      }),
    );
  });

  it.each(["metadata", "stream"] as const)(
    "makes a %s media-limit rejection visible and terminal",
    async (kind) => {
      const { runtime, account, config } = prepare();
      const fetchMock = stubUploadResponse();
      if (kind === "stream") {
        vi.mocked(runtime.channel.media.saveResponseMedia).mockRejectedValueOnce(
          Object.assign(new Error("payload exceeds maxBytes"), { code: "max_bytes" }),
        );
      }
      await handleClickClackInbound({
        account,
        config,
        message: createMediaMessage("upl_limit", kind === "metadata" ? 64 * 1024 * 1024 + 1 : 3),
      });

      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(kind === "metadata" ? 0 : 1);
      expect(sendClickClackTextMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "I could not process this attachment because it exceeds this bot's media limit.",
        }),
      );
    },
  );

  it.each([401, 403, 429, 500, 503])("keeps upload HTTP %i failures retryable", async (status) => {
    const { runtime, account, config } = prepare();
    stubUploadResponse(status);
    await expect(
      handleClickClackInbound({ account, config, message: createMediaMessage("upl_retry", 3) }),
    ).rejects.toMatchObject({ status });
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(sendClickClackTextMock).not.toHaveBeenCalled();
  });

  it("does not download attachments for an unadmitted sender", async () => {
    const { runtime, account, config } = prepare(
      createInboundAgentAccount({ allowFrom: ["usr_other"] }),
    );
    const fetchMock = stubUploadResponse();
    await handleClickClackInbound({
      account,
      config,
      message: createMediaMessage("upl_denied", 3),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(sendClickClackTextMock).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "sender policy"] as const)(
    "does not dispatch after %s changes during staging",
    async (change) => {
      const { runtime, account, config } = prepare();
      const abort = new AbortController();
      stubUploadResponse();
      vi.mocked(runtime.channel.media.saveResponseMedia).mockImplementationOnce(async () => {
        if (change === "shutdown") abort.abort();
        else publishInboundAccountConfig(runtime, { ...account, allowFrom: [] });
        return { id: "media", path: "/managed/plan.png", size: 3, contentType: "image/png" };
      });
      await handleClickClackInbound({
        account,
        config,
        message: createMediaMessage("upl_retired", 3),
        abortSignal: abort.signal,
      });
      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(sendClickClackTextMock).not.toHaveBeenCalled();
    },
  );

  const noticeCases = ["unsupported", "limit", "unavailable"] as const;
  function prepareBotNotice(kind: (typeof noticeCases)[number], conversationId: string) {
    const account = createInboundAgentAccount({
      workspace: `wsp_notice_${conversationId}`,
      allowFrom: ["usr_owner"],
      allowBots: true,
      replyMode: kind === "unsupported" ? "model" : "agent",
      botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
      config: { workspace: `wsp_notice_${conversationId}` },
    });
    const prepared = prepare(account);
    stubUploadResponse(kind === "unavailable" ? 404 : 200);
    const message = createMediaMessage("upl_notice", kind === "limit" ? 64 * 1024 * 1024 + 1 : 3, {
      workspace_id: account.workspace,
      direct_conversation_id: conversationId,
      author: createInboundAuthor({ kind: "bot" }),
    });
    return { ...prepared, message };
  }

  it.each(noticeCases)("budgets %s notices against bot loops", async (kind) => {
    const { account, config, runtime, message } = prepareBotNotice(kind, `dm_${kind}_budget`);
    await handleClickClackInbound({ account, config, message });
    await handleClickClackInbound({ account, config, message: { ...message, id: "msg_next" } });
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it.each(noticeCases)(
    "preserves same-message %s notice retries without another loop event",
    async (kind) => {
      const { account, config, message } = prepareBotNotice(kind, `dm_${kind}_retry`);
      const sendError = new Error("notice transport unavailable");
      sendClickClackTextMock.mockRejectedValueOnce(sendError);
      await expect(handleClickClackInbound({ account, config, message })).rejects.toBe(sendError);
      await handleClickClackInbound({ account, config, message });
      expect(sendClickClackTextMock).toHaveBeenCalledTimes(2);
    },
  );
});
