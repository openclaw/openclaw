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
function expectCall(mock: { mock: { calls: unknown[][] } }, ...args: unknown[]) {
  expect(mock.mock.calls).toMatchObject([args]);
}

type Api = (...args: unknown[]) => Promise<unknown>;
const uploadLocation = (upload_url = "https://files.slack.com/upload") => ({
  ok: true,
  upload_url,
  file_id: "F001",
});

function createUploadTestClient(slackApiUrl = "https://slack.com/api/") {
  const stub = {
    slackApiUrl,
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn<Api>(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => uploadLocation()),
      completeUploadExternal: vi.fn<Api>(async () => ({ ok: true })),
    },
  };
  return stub as typeof stub & WebClient;
}
type UploadTestClient = ReturnType<typeof createUploadTestClient>;

function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

type UploadOverrides = Omit<Partial<Parameters<typeof sendMessageSlack>[2]>, "cfg" | "client">;
type UploadParams = UploadOverrides & { target?: string; message?: string };

function sendUpload(client: UploadTestClient, params: UploadParams = {}) {
  const { target = "channel:C123CHAN", message = "caption", ...options } = params;
  return sendMessageSlack(target, message, {
    token: "xoxb-test",
    cfg: SLACK_TEST_CFG,
    client,
    mediaUrl: "/tmp/upload.png",
    ...options,
  });
}

function mockUploadDestination(client: UploadTestClient, uploadUrl: string) {
  client.files.getUploadURLExternal.mockResolvedValueOnce(uploadLocation(uploadUrl));
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
  async function captureFailure(params: UploadParams = {}) {
    const onPlatformSendDispatch = vi.fn();
    const error = await sendUpload(client, { ...params, onPlatformSendDispatch }).catch(
      (cause: unknown) => cause,
    );
    return { error, onPlatformSendDispatch };
  }
  async function expectTransferFailure(cause: Record<string, unknown>) {
    const { error, onPlatformSendDispatch } = await captureFailure();
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause });
    expectNoCompletion(onPlatformSendDispatch);
    return error;
  }
  function expectNoCompletion(onPlatformSendDispatch: ReturnType<typeof vi.fn>) {
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  }

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
    const hasRepliedRef = { value: false };
    client.chat.postMessage.mockRejectedValueOnce(new Error("Remaining Slack caption failed"));
    vi.spyOn(slackActionRuntime, "sendSlackMessage").mockImplementation(
      async (target, content, options) =>
        await sendSlackMessageThroughPublicOwner(target, content, { ...options, client }),
    );
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
  });

  it("marks account_inactive from files.getUploadURLExternal as a permanent non-dispatch", async () => {
    const rejection = slackPlatformError("account_inactive");
    client.files.getUploadURLExternal.mockRejectedValueOnce(rejection);
    const { error, onPlatformSendDispatch } = await captureFailure();
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ retryable: false, cause: rejection });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expectNoCompletion(onPlatformSendDispatch);
  });

  it("keeps a definitive completeUploadExternal rejection ambiguous", async () => {
    const rejection = slackPlatformError("messages_tab_disabled");
    client.files.completeUploadExternal.mockRejectedValueOnce(rejection);
    const { error, onPlatformSendDispatch } = await captureFailure();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(error).toBe(rejection);
    expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    await sendUpload(client, { target: "UABC123", token: "xoxb-test-a" });
    await sendUpload(client, { target: "user:UABC123", token: "xoxb-test-b" });
    expect(client.conversations.open.mock.calls).toEqual([
      [{ users: "UABC123" }],
      [{ users: "UABC123" }],
    ]);
    expect(client.files.completeUploadExternal.mock.calls).toMatchObject(
      Array.from({ length: 2 }, () => [
        { channel_id: "D99RESOLVED", files: [{ id: "F001", title: "screenshot.png" }] },
      ]),
    );
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
    await expect(Promise.race([sendPromise, Promise.resolve("pending")])).resolves.toBe("pending");
    completionResult.resolve({ ok: true });
    const result = await sendPromise;

    expectCall(loadOutboundMediaFromUrlMock, "/tmp/threaded.png", { optimizeImages: false });
    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expectCall(vi.mocked(globalThis.fetch), "https://files.slack.com/upload", { method: "POST" });
    expectCall(buildTimeoutAbortSignal, { timeoutMs: 120_000, url: "https://files.slack.com" });
    expectCall(fetchWithSsrFGuard, {
      timeoutMs: 120_000,
      signal: expect.any(AbortSignal),
      capture: false,
    });
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(events).toEqual(["byte-upload", "dispatch-start", "dispatch-end", "completion"]);
    expectCall(client.files.completeUploadExternal, {
      channel_id: "C123CHAN",
      initial_comment: "caption",
      thread_ts: "171.222",
      files: [{ id: "F001", title: "Custom Title" }],
    });
    expect(hasSlackThreadParticipation("default", "C123CHAN", "171.222")).toBe(true);
    expect(result).toMatchObject({ messageId: "F001", receipt: { threadId: "171.222" } });
  });

  it("preserves HTTP upload URLs on an alternate Slack API origin", async () => {
    await withServer(
      (req, res) => {
        expect(req).toMatchObject({ method: "POST", url: "/upload/v1/capability" });
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

  it.each<
    [
      string | undefined,
      string | undefined,
      string | undefined,
      "private" | "Error" | "host" | "origin" | undefined,
    ]
  >([
    ["https://slack-relay.example", undefined, "93.184.216.34", undefined],
    ["https://slack-gov.com", "https://files.slack-gov.com", undefined, undefined],
    [undefined, undefined, "198.18.0.10", undefined],
    [undefined, undefined, "10.0.0.1", "private"],
    [undefined, "http://files.slack.com", undefined, "Error"],
    ["https://slack.com.", "https://files.slack-gov.com", undefined, "host"],
    [undefined, "https://future-upload.slack.com", undefined, "host"],
    ["http://api.example", "http://other.example", undefined, "origin"],
  ])(
    "enforces destination policy (API %s, upload %s, DNS %s): %s",
    async (api, upload, lookup, failure) => {
      const caseClient = createUploadTestClient(api);
      if (upload) {
        mockUploadDestination(caseClient, upload);
      }
      const networkFetch = vi.fn(async () => new Response("ok"));
      if (failure !== "origin") {
        await useRealUploadGuard(networkFetch, lookup);
      }
      const result = sendUpload(caseClient);
      if (!failure) {
        await result;
        expect(networkFetch).toHaveBeenCalledOnce();
        expect(caseClient.files.completeUploadExternal).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ channel_id: "C123CHAN" }),
        );
        return;
      }
      if (failure === "origin") {
        await expect(result).rejects.toThrow("must match the configured Slack API origin");
        expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
      } else {
        const error = await result.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        if (failure !== "private") {
          expect(error).toMatchObject({
            cause: { name: failure === "host" ? "SsrFBlockedError" : failure },
          });
        }
      }
      expect(networkFetch).not.toHaveBeenCalled();
      expect(caseClient.files.completeUploadExternal).not.toHaveBeenCalled();
    },
  );

  it("times out a hanging presigned URL upload", async () => {
    const closedResponse = createDeferred<void>();

    await withServer(
      (req, res) => {
        req.resume();
        expect(req).toMatchObject({ method: "POST", url: "/upload" });
        res.once("close", closedResponse.resolve);
        // Trigger cancellation only after the request arrives, independent of CI load.
        uploadTimeout.controller.abort(
          Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
        );
      },
      async (baseUrl) => {
        globalThis.fetch = originalFetch;
        mockUploadDestination(client, `${baseUrl}/upload`);

        await expectTransferFailure({ name: "TimeoutError" });

        await closedResponse.promise;
        expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
      },
    );
  });

  it("rejects a non-200 byte-upload response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expectTransferFailure({ code: "HTTP_204" });
  });

  it("marks a non-timeout byte-upload transport failure as not dispatched", async () => {
    const transportError = Object.assign(
      new Error("https://files.slack.com/upload/v1/CAPABILITY_SENTINEL?token=QUERY_SENTINEL"),
      { code: "ECONNRESET" },
    );
    globalThis.fetch = vi.fn(async () => {
      throw transportError;
    });

    const error = await expectTransferFailure({ code: "ECONNRESET" });
    expect(formatErrorMessage(error)).not.toContain("CAPABILITY_SENTINEL");
    expect(formatErrorMessage(error)).not.toContain("QUERY_SENTINEL");
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
  });

  it("keeps completion error responses ambiguous", async () => {
    client.files.completeUploadExternal.mockResolvedValueOnce({
      ok: false,
      error: "completion_failed",
    });
    const { error, onPlatformSendDispatch } = await captureFailure();
    expect(error).toMatchObject({ message: "Failed to complete upload: completion_failed" });
    expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("uses a generic filename for a document without MIME or a name", async () => {
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      kind: "document",
    });

    await sendUpload(client, {
      mediaUrl: "https://example.com/?attachment=artifact",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "upload",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ files: [{ id: "F001", title: "upload" }] }),
    );
  });
});
