import type { WebClient } from "@slack/web-api";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import type { WebMediaResult } from "openclaw/plugin-sdk/web-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./blocks.test-helpers.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown): Promise<WebMediaResult> => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const cleanupUploadTimeout = vi.hoisted(() => vi.fn());
const uploadTimeout = vi.hoisted(() => ({ controller: new AbortController() }));
const buildTimeoutAbortSignal = vi.hoisted(() =>
  vi.fn(() => {
    uploadTimeout.controller = new AbortController();
    return {
      signal: uploadTimeout.controller.signal,
      cleanup: cleanupUploadTimeout,
      refresh: () => {},
    };
  }),
);
const fetchWithSsrFGuard = vi.fn(
  async (
    params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
  ) => ({
    response: await fetch(params.url, { ...params.init, signal: params.signal }),
    finalUrl: params.url,
    release: async () => {},
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: Parameters<typeof fetchWithSsrFGuard>) =>
    fetchWithSsrFGuard(...args),
}));
vi.mock("openclaw/plugin-sdk/extension-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/extension-shared")>()),
  buildTimeoutAbortSignal,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  }),
}));
vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type ApiMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
type UploadTestClient = WebClient & {
  conversations: { open: ApiMock };
  chat: { postMessage: ApiMock };
  files: {
    getUploadURLExternal: ApiMock;
    completeUploadExternal: ApiMock;
  };
};

function createUploadTestClient(slackApiUrl = "https://slack.com/api/"): UploadTestClient {
  return {
    slackApiUrl,
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as UploadTestClient;
}

function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

type UploadOverrides = Omit<Partial<Parameters<typeof sendMessageSlack>[2]>, "cfg" | "client">;
type UploadParams = UploadOverrides & { mediaUrl: string; target?: string; message?: string };

function sendUpload(client: UploadTestClient, params: UploadParams) {
  const { target = "channel:C123CHAN", message = "caption", ...options } = params;
  return sendMessageSlack(target, message, {
    token: "xoxb-test",
    cfg: SLACK_TEST_CFG,
    client,
    ...options,
  });
}

function mockUploadDestination(client: UploadTestClient, uploadUrl: string) {
  client.files.getUploadURLExternal.mockResolvedValueOnce({
    ok: true,
    upload_url: uploadUrl,
    file_id: "F001",
  });
}

async function useRealUploadGuard(networkFetch: typeof fetch, lookupAddress?: string) {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  const lookupFn = lookupAddress
    ? ((async () => [{ address: lookupAddress, family: 4 }]) as unknown as LookupFn)
    : undefined;
  fetchWithSsrFGuard.mockImplementationOnce(async (params) =>
    actual.fetchWithSsrFGuard({
      ...params,
      fetchImpl: networkFetch,
      ...(lookupFn ? { lookupFn } : {}),
    }),
  );
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;
  let client: UploadTestClient;

  beforeEach(() => {
    client = createUploadTestClient();
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    fetchWithSsrFGuard.mockClear();
    buildTimeoutAbortSignal.mockClear();
    cleanupUploadTimeout.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackThreadParticipationCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records an accepted batched upload when its remaining caption post fails", async () => {
    const { handleSlackAction, slackActionRuntime } = await import("./action-runtime.js");
    const { sendSlackMessage: sendSlackMessageThroughPublicOwner } = await import("./actions.js");
    const originalSender = slackActionRuntime.sendSlackMessage;
    const hasRepliedRef = { value: false };
    client.chat.postMessage.mockRejectedValueOnce(new Error("Remaining Slack caption failed"));
    slackActionRuntime.sendSlackMessage = async (target, content, options) =>
      await sendSlackMessageThroughPublicOwner(target, content, { ...options, client });

    try {
      await expect(
        handleSlackAction(
          {
            action: "uploadFile",
            to: "channel:C123CHAN",
            filePath: "/tmp/report.txt",
            initialComment: "a".repeat(8500),
          },
          SLACK_TEST_CFG,
          {
            currentChannelId: "C123CHAN",
            currentThreadTs: "1111111111.111111",
            replyToMode: "batched",
            hasRepliedRef,
          },
        ),
      ).rejects.toThrow("Remaining Slack caption failed");

      expect(client.files.completeUploadExternal).toHaveBeenCalledOnce();
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(hasRepliedRef.value).toBe(true);
    } finally {
      slackActionRuntime.sendSlackMessage = originalSender;
    }
  });

  it("marks account_inactive from files.getUploadURLExternal as a permanent non-dispatch", async () => {
    const rejection = slackPlatformError("account_inactive");
    const onPlatformSendDispatch = vi.fn();
    client.files.getUploadURLExternal.mockRejectedValueOnce(rejection);

    const caught = await sendUpload(client, {
      mediaUrl: "/tmp/account-inactive.png",
      onPlatformSendDispatch,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: rejection });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("keeps a definitive completeUploadExternal rejection ambiguous", async () => {
    const rejection = slackPlatformError("messages_tab_disabled");
    const onPlatformSendDispatch = vi.fn();
    client.files.completeUploadExternal.mockRejectedValueOnce(rejection);

    const caught = await sendUpload(client, {
      mediaUrl: "/tmp/messages-tab-disabled.png",
      onPlatformSendDispatch,
    }).catch((error: unknown) => error);

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(caught).toBe(rejection);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    await sendUpload(client, {
      target: "UABC123",
      message: "first",
      token: "xoxb-test-a",
      mediaUrl: "/tmp/first.png",
    });
    await sendUpload(client, {
      target: "user:UABC123",
      message: "second",
      token: "xoxb-test-b",
      mediaUrl: "/tmp/second.png",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
    expect(client.conversations.open).toHaveBeenCalledWith({ users: "UABC123" });
    expect(client.files.completeUploadExternal).toHaveBeenCalledTimes(2);
    for (const call of [1, 2]) {
      expect(client.files.completeUploadExternal).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({
          channel_id: "D99RESOLVED",
          files: [{ id: "F001", title: "screenshot.png" }],
        }),
      );
    }
  });

  it("uploads the named original file, disposes transfer resources, then completes the threaded send", async () => {
    const events: string[] = [];
    const uploadResponse = new Response("ok", { status: 200 });
    const cancelUploadBody = vi.spyOn(uploadResponse.body!, "cancel");
    cancelUploadBody.mockRejectedValueOnce(new Error("response body cleanup failed"));
    globalThis.fetch = vi.fn(async () => {
      events.push("byte-upload");
      return uploadResponse;
    });
    const completionStarted = createDeferred<void>();
    const completionResult = createDeferred<{ ok: true }>();
    client.files.completeUploadExternal.mockImplementationOnce(() => {
      events.push("completion");
      completionStarted.resolve();
      return completionResult.promise;
    });
    const dispatchStarted = createDeferred<void>();
    const dispatchFinished = createDeferred<void>();
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch-start");
      dispatchStarted.resolve();
      await dispatchFinished.promise;
      events.push("dispatch-end");
    });

    const sendPromise = sendUpload(client, {
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
      forceDocument: true,
      uploadFileName: "custom-name.bin",
      uploadTitle: "Custom Title",
      onPlatformSendDispatch,
    });
    await dispatchStarted.promise;
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
    dispatchFinished.resolve();
    await completionStarted.promise;
    expect(cancelUploadBody).toHaveBeenCalledOnce();
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
    await expect(
      Promise.race([
        sendPromise.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    completionResult.resolve({ ok: true });
    const result = await sendPromise;

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith(
      "/tmp/threaded.png",
      expect.objectContaining({ optimizeImages: false }),
    );
    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://files.slack.com/upload",
      expect.objectContaining({ method: "POST" }),
    );
    expect(buildTimeoutAbortSignal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timeoutMs: 120_000,
        url: "https://files.slack.com",
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timeoutMs: 120_000,
        signal: expect.any(AbortSignal),
        capture: false,
      }),
    );
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(events).toEqual(["byte-upload", "dispatch-start", "dispatch-end", "completion"]);
    expect(client.files.completeUploadExternal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
        files: [{ id: "F001", title: "Custom Title" }],
      }),
    );
    expect(hasSlackThreadParticipation("default", "C123CHAN", "171.222")).toBe(true);
    expect(result.receipt.threadId).toBe("171.222");
    expect(result.messageId).toBe("F001");
  });

  it("preserves HTTP upload URLs on an alternate Slack API origin", async () => {
    await withServer(
      (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/upload/v1/capability");
        req.resume();
        res.end("ok");
      },
      async (baseUrl) => {
        vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
        vi.stubEnv("no_proxy", "127.0.0.1,localhost");
        const alternateClient = createUploadTestClient(`${baseUrl}/api/`);
        const onDeliveryResult = vi.fn();
        mockUploadDestination(alternateClient, `${baseUrl}/upload/v1/capability`);
        globalThis.fetch = originalFetch;
        await useRealUploadGuard(originalFetch);

        const result = await sendUpload(alternateClient, {
          mediaUrl: "/tmp/alternate-root.png",
          message: "a".repeat(8_500),
          threadTs: "171.222",
          onDeliveryResult,
        });

        expect(
          onDeliveryResult.mock.calls.map(([delivery]) => delivery.receipt.parts[0]?.kind),
        ).toEqual(["media", "text"]);
        expect(result.receipt).toMatchObject({
          threadId: "171.222",
          parts: [
            { platformMessageId: "F001", kind: "media", index: 0, threadId: "171.222" },
            { platformMessageId: "171234.567", kind: "text", index: 1, threadId: "171.222" },
          ],
        });
      },
    );
  });

  it.each([
    {
      name: "allows an exact Slack upload host returned by a custom API root",
      apiUrl: "https://slack-relay.example/api/",
      uploadUrl: "https://files.slack.com/upload/v1/relayed-capability",
      lookupAddress: "93.184.216.34",
    },
    {
      name: "allows GovSlack upload destinations through the real hostname guard",
      apiUrl: "https://slack-gov.com/api/",
      uploadUrl: "https://files.slack-gov.com/upload/v1/gov-capability",
      lookupAddress: undefined,
    },
    {
      name: "retains the shipped RFC2544 fake-IP path for an exact Slack upload host",
      apiUrl: undefined,
      uploadUrl: undefined,
      lookupAddress: "198.18.0.10",
    },
  ])("$name", async ({ apiUrl, uploadUrl, lookupAddress }) => {
    const caseClient = createUploadTestClient(apiUrl);
    if (uploadUrl) {
      mockUploadDestination(caseClient, uploadUrl);
    }
    const networkFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await useRealUploadGuard(networkFetch, lookupAddress);

    await sendUpload(caseClient, { mediaUrl: "/tmp/allowed-upload.png" });

    expect(networkFetch).toHaveBeenCalledOnce();
    expect(caseClient.files.completeUploadExternal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("rejects exact Slack upload hosts resolving to a private address", async () => {
    const networkFetch = vi.fn(async () => new Response("unexpected"));
    await useRealUploadGuard(networkFetch, "10.0.0.1");

    await expect(sendUpload(client, { mediaUrl: "/tmp/private-address.png" })).rejects.toThrow();

    expect(networkFetch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["plaintext Slack", "https://slack.com/api/", "http://files.slack.com/upload/v1/plaintext"],
    [
      "trailing-dot commercial Slack to GovSlack",
      "https://slack.com./api/",
      "https://files.slack-gov.com/upload/v1/cross-plane",
    ],
    [
      "undocumented commercial subdomain",
      "https://slack.com/api/",
      "https://future-upload.slack.com/upload/v1/capability",
    ],
  ])("rejects %s upload destinations before network access", async (label, apiUrl, uploadUrl) => {
    const rejectedClient = createUploadTestClient(apiUrl);
    mockUploadDestination(rejectedClient, uploadUrl);
    const networkFetch = vi.fn(async () => new Response("unexpected"));
    const errorName = uploadUrl.startsWith("http:") ? "Error" : "SsrFBlockedError";
    await useRealUploadGuard(networkFetch);

    const rejection = await sendUpload(rejectedClient, {
      mediaUrl: "/tmp/rejected-upload.png",
    }).catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ cause: expect.objectContaining({ name: errorName }) });

    expect(networkFetch).not.toHaveBeenCalled();
    expect(rejectedClient.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("rejects upload destinations outside an explicitly configured API origin", async () => {
    const originClient = createUploadTestClient("http://slack-compatible.example/api/");
    mockUploadDestination(originClient, "http://other-compatible.example/upload/v1/capability");

    await expect(sendUpload(originClient, { mediaUrl: "/tmp/wrong-origin.png" })).rejects.toThrow(
      "must match the configured Slack API origin",
    );

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(originClient.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("times out a hanging presigned URL upload", async () => {
    const closedResponse = createDeferred<void>();

    await withServer(
      (req, res) => {
        req.resume();
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/upload");
        res.once("close", closedResponse.resolve);
        // Trigger cancellation only after the request arrives, independent of CI load.
        uploadTimeout.controller.abort(
          Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
        );
      },
      async (baseUrl) => {
        globalThis.fetch = originalFetch;
        mockUploadDestination(client, `${baseUrl}/upload`);

        const onPlatformSendDispatch = vi.fn();
        const error = await sendUpload(client, {
          mediaUrl: "/tmp/hanging.png",
          onPlatformSendDispatch,
        }).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        expect(error).toMatchObject({
          cause: expect.objectContaining({ name: "TimeoutError" }),
        });

        await closedResponse.promise;
        expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
        expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects a non-200 byte-upload response", async () => {
    const onPlatformSendDispatch = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));

    const error = await sendUpload(client, {
      mediaUrl: "/tmp/non-200.png",
      onPlatformSendDispatch,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause: { code: "HTTP_204" } });
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("marks a non-timeout byte-upload transport failure as not dispatched", async () => {
    const onPlatformSendDispatch = vi.fn();
    const transportError = Object.assign(
      new Error(
        "socket closed at https://files.slack.com/upload/v1/CAPABILITY_SENTINEL?token=QUERY_SENTINEL",
      ),
      { code: "ECONNRESET" },
    );
    globalThis.fetch = vi.fn(async () => {
      throw transportError;
    });

    const error = await sendUpload(client, {
      mediaUrl: "/tmp/transport-failure.png",
      onPlatformSendDispatch,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause: { code: "ECONNRESET" } });
    expect(formatErrorMessage(error)).not.toContain("CAPABILITY_SENTINEL");
    expect(formatErrorMessage(error)).not.toContain("QUERY_SENTINEL");
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("keeps completion error responses ambiguous", async () => {
    const onPlatformSendDispatch = vi.fn();
    client.files.completeUploadExternal.mockResolvedValueOnce({
      ok: false,
      error: "completion_failed",
    });
    const error = await sendUpload(client, {
      mediaUrl: "/tmp/completion-error-response.png",
      onPlatformSendDispatch,
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: "Failed to complete upload: completion_failed" });
    expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it.each([[undefined, "upload"]] as const)(
    "infers the unnamed document filename from MIME %s",
    async (contentType, fileName) => {
      loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
        buffer: Buffer.from("fake-image"),
        contentType,
        kind: "document",
      });

      await sendUpload(client, {
        mediaUrl: "https://example.com/?attachment=artifact",
      });

      expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
        filename: fileName,
        length: Buffer.from("fake-image").length,
      });
      expect(client.files.completeUploadExternal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ files: [{ id: "F001", title: fileName }] }),
      );
    },
  );
});
