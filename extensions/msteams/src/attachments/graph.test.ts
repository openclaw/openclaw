import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock shared.js to avoid transitive runtime-api imports that pull in uninstalled packages.
vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    applyAuthorizationHeaderForUrl: vi.fn(),
    GRAPH_ROOT: "https://graph.microsoft.com/v1.0",
    resolveMSTeamsMediaKind: vi.fn(({ contentType }: { contentType?: string }) =>
      contentType?.startsWith("image/") ? "image" : "document",
    ),
    normalizeContentType: vi.fn((ct: string | null | undefined) => ct ?? undefined),
    resolveAttachmentFetchPolicy: vi.fn(() => ({ allowHosts: ["*"], authAllowHosts: ["*"] })),
    safeFetchWithPolicy: vi.fn(),
  };
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

type GuardedFetchParams = { url: string; init?: RequestInit; timeoutMs?: number };

function guardedFetchResult(
  params: GuardedFetchParams,
  response: Response,
  release: () => Promise<void> = async () => {},
) {
  return {
    response,
    release,
    finalUrl: params.url,
  };
}

function mockGraphMediaFetch(options: {
  messageResponse?: unknown;
  hostedContents?: unknown[];
  valueResponses?: Record<string, Response>;
  collectionResponse?: Response | Error;
  releaseMessage?: () => Promise<void>;
  releaseCollection?: () => Promise<void>;
}) {
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params: GuardedFetchParams) => {
    const url = params.url;
    for (const [fragment, response] of Object.entries(options.valueResponses ?? {})) {
      if (url.includes(fragment)) {
        return guardedFetchResult(params, response);
      }
    }
    if (url === messageUrl || url === `${messageUrl}/hostedContents`) {
      const isMessage = url === messageUrl;
      const response = isMessage
        ? (options.messageResponse ?? { body: {}, attachments: [] })
        : (options.collectionResponse ?? { value: options.hostedContents ?? [] });
      if (response instanceof Error) {
        throw response;
      }
      return guardedFetchResult(
        params,
        response instanceof Response ? response : mockFetchResponse(response),
        isMessage ? options.releaseMessage : options.releaseCollection,
      );
    }
    return guardedFetchResult(params, mockFetchResponse({}, 404));
  });
}

describe("downloadMSTeamsGraphMedia hosted content $value fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips hosted content when the list item has no id", async () => {
    mockGraphMediaFetch({
      hostedContents: [{ contentType: "image/png" }],
    });

    const result = await downloadGraphMediaWithDefaults();

    expect(result.media).toEqual([{ kind: "image", contentType: "image/png" }]);
  });

  it("skips hosted content when the Graph collection response exceeds the byte cap", async () => {
    const hugeResponse = mockFetchResponse(
      oversizedGraphJson({
        value: [{ id: "hosted-huge", contentType: "image/png" }],
      }),
    );

    mockGraphMediaFetch({
      valueResponses: {
        "/hostedContents": hugeResponse,
      },
    });

    const result = await downloadGraphMediaWithDefaults();

    expect(result.media).toHaveLength(0);
    expect(result.hostedCount).toBe(0);
    expect(hugeResponse.bodyUsed).toBe(true);
  });

  it("cancels the unread $value body when the hosted content bytes fetch fails", async () => {
    const failedValueResponse = new Response("server error", { status: 500 });

    mockGraphMediaFetch({
      hostedContents: [{ id: "hosted-500", contentType: "image/png" }],
      valueResponses: {
        "/hostedContents/hosted-500/$value": failedValueResponse,
      },
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

  it("adds the OpenClaw User-Agent to Graph shares downloads for reference attachments", async () => {
    mockGraphMediaFetch({
      messageResponse: referenceMessage("file.docx"),
    });
    vi.mocked(safeFetchWithPolicy).mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockImplementation(async (params) => {
      if (params.fetchImpl) {
        await params.fetchImpl(params.url, {});
      }
      return {
        path: "/tmp/file.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        kind: "document",
      };
    });

    await downloadGraphMediaWithDefaults();

    const fetchParams = vi.mocked(safeFetchWithPolicy).mock.calls[0]?.[0];
    expect(fetchParams).toBeDefined();
    if (!fetchParams) {
      throw new Error("expected safeFetchWithPolicy call");
    }
    expect(fetchParams.timeoutMs).toBe(30_000);
    expect(fetchParams.requestInit?.headers).toBeInstanceOf(Headers);
    const requestInit = fetchParams.requestInit;
    const headers = requestInit?.headers as Headers;
    expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
    for (const [call] of vi.mocked(fetchWithSsrFGuard).mock.calls) {
      expect(call.url.endsWith("/attachments")).toBe(false);
      expect(call.timeoutMs).toBe(30_000);
      expect(call.init?.headers).toBeInstanceOf(Headers);
      const graphHeaders = new Headers(call.init?.headers);
      expect(graphHeaders.get("Authorization")).toBe("Bearer test-token");
      expect(graphHeaders.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
    }
  });
});

describe("downloadMSTeamsGraphMedia attachment sourcing and error logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases message metadata before starting nested SharePoint downloads", async () => {
    const order: string[] = [];
    mockGraphMediaFetch({
      messageResponse: referenceMessage("release.pdf"),
      releaseMessage: async () => {
        order.push("message-release");
      },
    });
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockImplementation(async () => {
      order.push("sharepoint-download");
      return { path: "/tmp/release.pdf", contentType: "application/pdf", kind: "document" };
    });

    const result = await downloadGraphMediaWithDefaults();

    expect(order.slice(0, 2)).toEqual(["message-release", "sharepoint-download"]);
    expect(result.media).toEqual([
      { path: "/tmp/release.pdf", contentType: "application/pdf", kind: "document" },
    ]);
    expect(result.attachmentCount).toBe(1);
  });

  it("skips message metadata when the Graph response exceeds the byte cap", async () => {
    mockGraphMediaFetch({
      messageResponse: oversizedGraphJson({ attachments: [] }),
    });
    const logger = { warn: vi.fn() };

    const result = await downloadGraphMediaWithDefaults({ logger });

    expect(result.media).toHaveLength(0);
    expect(result.attachmentCount).toBe(0);
    expect(logger.warn.mock.calls[0]).toEqual([
      "msteams graph message parse failed",
      expect.objectContaining({
        error: "MS Teams Graph message: JSON response exceeds 16777216 bytes",
      }),
    ]);
  });

  it("logs a debug event when the message fetch throws instead of swallowing it", async () => {
    // Regression #51749: surface the fetch error, not just an empty result.
    mockGraphMediaFetch({ messageResponse: new Error("network boom") });
    const logger = { warn: vi.fn() };

    const result = await downloadGraphMediaWithDefaults({ logger });

    expect(result.media).toHaveLength(0);
    expect(logger.warn.mock.calls[0]).toEqual([
      "msteams graph message fetch failed",
      { error: "network boom" },
    ]);
  });

  it("keeps downloaded message attachments when hosted content lookup fails", async () => {
    mockGraphMediaFetch({
      collectionResponse: new Error("hosted content unavailable"),
      messageResponse: referenceMessage("partial.pdf"),
    });
    vi.mocked(downloadAndStoreMSTeamsRemoteMedia).mockResolvedValue({
      path: "/tmp/partial.pdf",
      contentType: "application/pdf",
      kind: "document",
    });
    const logger = { warn: vi.fn() };

    const result = await downloadGraphMediaWithDefaults({ logger });

    expect(result.media).toEqual([
      { path: "/tmp/partial.pdf", contentType: "application/pdf", kind: "document" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith("msteams graph hostedContents fetch failed", {
      error: "hosted content unavailable",
    });
  });

  it("logs a debug event when the message fetch returns non-ok", async () => {
    const failedMessageResponse = mockFetchResponse({ error: "forbidden" }, 403);
    mockGraphMediaFetch({ messageResponse: failedMessageResponse });
    const logger = { debug: vi.fn() };

    const result = await downloadGraphMediaWithDefaults({ logger });

    expect(result.media).toHaveLength(0);
    expect(result.attachmentStatus).toBe(403);
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
