import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return { ...actual, safeFetchWithPolicy: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("./remote-media.js", () => ({
  downloadAndStoreMSTeamsRemoteMedia: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { downloadMSTeamsGraphMedia } from "./graph.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import { safeFetchWithPolicy } from "./shared.js";

const messageUrl = "https://graph.microsoft.com/v1.0/chats/c/messages/msg";

function downloadGraphMediaWithDefaults(
  params: Partial<Parameters<typeof downloadMSTeamsGraphMedia>[0]> = {},
) {
  return downloadMSTeamsGraphMedia({
    messageUrl,
    tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    maxBytes: 10 * 1024 * 1024,
    ...params,
  });
}

function mockFetchResponse(body: unknown, status = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, { status, headers: { "content-type": "application/json" } });
}

function oversizedGraphJson(payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, padding: "x".repeat(16 * 1024 * 1024) });
}

function referenceMessage(name: string) {
  return {
    attachments: [
      { contentType: "reference", contentUrl: `https://tenant.sharepoint.com/${name}`, name },
    ],
  };
}

function savedDocument(name: string) {
  return { path: `/tmp/${name}`, contentType: "application/pdf", kind: "document" as const };
}

function mockGraphMediaFetch(options: {
  messageResponse?: unknown;
  hostedContents?: unknown[];
  valueResponses?: Record<string, Response>;
  collectionResponse?: Response | Error;
  releaseMessage?: () => Promise<void>;
  releaseCollection?: () => Promise<void>;
}) {
  const responses: Record<string, unknown> = {
    "": options.messageResponse ?? { body: {}, attachments: [] },
    "/hostedContents": options.collectionResponse ?? {
      value: options.hostedContents ?? [],
    },
    ...options.valueResponses,
  };
  const releases = new Map([
    ["", options.releaseMessage],
    ["/hostedContents", options.releaseCollection],
  ]);
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params) => {
    const url = params.url;
    const suffix = url.slice(messageUrl.length);
    const response =
      (url.startsWith(messageUrl) && responses[suffix]) || mockFetchResponse({}, 404);
    if (response instanceof Error) {
      throw response;
    }
    return {
      response: response instanceof Response ? response : mockFetchResponse(response),
      release: releases.get(suffix) ?? (async () => {}),
      finalUrl: url,
    };
  });
}

beforeEach(() => vi.clearAllMocks());

describe("downloadMSTeamsGraphMedia", () => {
  it("skips hosted content when the list item has no id", async () => {
    mockGraphMediaFetch({ hostedContents: [{ contentType: "image/png" }] });
    const result = await downloadGraphMediaWithDefaults();
    expect(result.media).toEqual([{ kind: "image", contentType: "image/png" }]);
  });

  it("skips hosted content when the Graph collection response exceeds the byte cap", async () => {
    const hugeResponse = mockFetchResponse(
      oversizedGraphJson({
        value: [{ id: "hosted-huge", contentType: "image/png" }],
      }),
    );
    mockGraphMediaFetch({ collectionResponse: hugeResponse });
    const result = await downloadGraphMediaWithDefaults();
    expect(result).toMatchObject({ media: [], hostedCount: 0 });
    expect(hugeResponse.bodyUsed).toBe(true);
  });

  it("cancels the unread $value body when the hosted content bytes fetch fails", async () => {
    const failedValueResponse = new Response("server error", { status: 500 });
    mockGraphMediaFetch({
      hostedContents: [{ id: "hosted-500", contentType: "image/png" }],
      valueResponses: { "/hostedContents/hosted-500/$value": failedValueResponse },
    });
    const result = await downloadGraphMediaWithDefaults();
    expect(result.media).toEqual([
      { kind: "image", contentType: "image/png", sourceId: "hosted-500" },
    ]);
    expect(failedValueResponse.bodyUsed).toBe(true);
  });

  it("releases a cloned failed collection body without awaiting stalled cancellation", async () => {
    const failedCollectionResponse = new Response("server error", { status: 500 });
    const captureClone = failedCollectionResponse.clone();
    const body = failedCollectionResponse.body;
    if (!body) {
      throw new Error("expected a readable collection error body");
    }
    const originalCancel = body.cancel.bind(body);
    let cancellation: Promise<void> | undefined;
    let cancellationSettled = false;
    const cancellationStarted = new Promise<void>((resolve) => {
      vi.spyOn(body, "cancel").mockImplementation((reason) => {
        cancellation = originalCancel(reason).finally(() => {
          cancellationSettled = true;
        });
        resolve();
        return cancellation;
      });
    });
    const release = vi.fn(async () => {});
    mockGraphMediaFetch({
      collectionResponse: failedCollectionResponse,
      releaseCollection: release,
    });
    const operation = downloadGraphMediaWithDefaults();
    try {
      await cancellationStarted;
      expect(release).toHaveBeenCalledOnce();
      expect(failedCollectionResponse.bodyUsed).toBe(true);
      expect(cancellationSettled).toBe(false);
      await expect(operation).resolves.toMatchObject({
        media: [],
        hostedCount: 0,
        hostedStatus: 500,
      });
    } finally {
      void captureClone.body?.cancel().catch(() => undefined);
      await cancellation?.catch(() => undefined);
      await operation.catch(() => undefined);
    }
  });

  it("releases metadata before reference downloads with Graph and User-Agent headers", async () => {
    const order: string[] = [];
    mockGraphMediaFetch({
      messageResponse: referenceMessage("release.pdf"),
      releaseMessage: async () => {
        order.push("message-release");
      },
    });
    vi.mocked(safeFetchWithPolicy).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockImplementation(async (params) => {
      order.push("sharepoint-download");
      if (params.fetchImpl) {
        await params.fetchImpl(params.url, {});
      }
      return savedDocument("release.pdf");
    });
    const result = await downloadGraphMediaWithDefaults();
    expect(order.slice(0, 2)).toEqual(["message-release", "sharepoint-download"]);
    expect(result.media).toEqual([savedDocument("release.pdf")]);
    expect(result.attachmentCount).toBe(1);
    const [fetchParams] = vi.mocked(safeFetchWithPolicy).mock.calls[0]!;
    expect(fetchParams.timeoutMs).toBe(30_000);
    const headers = new Headers(fetchParams.requestInit?.headers);
    expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
    for (const [call] of vi.mocked(fetchWithSsrFGuard).mock.calls) {
      expect(call.url.endsWith("/attachments")).toBe(false);
      expect(call.timeoutMs).toBe(30_000);
      const graphHeaders = new Headers(call.init?.headers);
      expect(graphHeaders.get("Authorization")).toBe("Bearer test-token");
      expect(graphHeaders.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
    }
  });
  it.each([
    [
      "parse",
      () => oversizedGraphJson({ attachments: [] }),
      "MS Teams Graph message: JSON response exceeds 16777216 bytes",
    ],
    ["fetch", () => new Error("network boom"), "network boom"],
  ] as const)("logs message %s failures and returns no media", async (phase, response, error) => {
    mockGraphMediaFetch({ messageResponse: response() });
    const logger = { warn: vi.fn() };
    const result = await downloadGraphMediaWithDefaults({ logger });
    expect(result).toMatchObject({ media: [], attachmentCount: 0 });
    expect(logger.warn.mock.calls[0]).toEqual([
      `msteams graph message ${phase} failed`,
      phase === "parse" ? expect.objectContaining({ error }) : { error },
    ]);
  });

  it("keeps downloaded message attachments when hosted content lookup fails", async () => {
    mockGraphMediaFetch({
      collectionResponse: new Error("hosted content unavailable"),
      messageResponse: referenceMessage("partial.pdf"),
    });
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockResolvedValue(savedDocument("partial.pdf"));
    const logger = { warn: vi.fn() };
    const result = await downloadGraphMediaWithDefaults({ logger });
    expect(result.media).toEqual([savedDocument("partial.pdf")]);
    expect(logger.warn).toHaveBeenCalledWith("msteams graph hostedContents fetch failed", {
      error: "hosted content unavailable",
    });
  });

  it("logs a debug event when the message fetch returns non-ok", async () => {
    const failedMessageResponse = mockFetchResponse({ error: "forbidden" }, 403);
    mockGraphMediaFetch({ messageResponse: failedMessageResponse });
    const logger = { debug: vi.fn() };
    const result = await downloadGraphMediaWithDefaults({ logger });
    expect(result).toMatchObject({ media: [], attachmentStatus: 403 });
    expect(failedMessageResponse.bodyUsed).toBe(true);
    expect(logger.debug.mock.calls[0]).toEqual([
      "graph media message fetch not ok",
      expect.objectContaining({ status: 403 }),
    ]);
  });

  it("bounds stalled token acquisition to the shared operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = downloadGraphMediaWithDefaults({
        tokenProvider: { getAccessToken: vi.fn(() => new Promise<string>(() => {})) },
        deadline: {
          label: "MS Teams inbound preprocessing",
          timeoutMs: 50,
          deadlineAtMs: Date.now() + 50,
        },
      });
      const assertion = expect(resultPromise).resolves.toMatchObject({ tokenError: true });
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
