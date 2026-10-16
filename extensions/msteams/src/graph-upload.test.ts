import { Readable } from "node:stream";
import { text as readBody } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requestUrl, withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  requireMSTeamsSharePointSiteId,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import {
  MSTEAMS_REQUEST_TIMEOUT_MS,
  resolveMSTeamsSharePointUploadTimeoutMs,
} from "./request-timeout.js";

const SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS = resolveMSTeamsSharePointUploadTimeoutMs(0);
const DEFAULT_BUFFER = Buffer.from("world");
const DEFAULT_UPLOAD_RESULT = { id: "item-1", webUrl: "https://example.com/1", name: "a.txt" };
const DEFAULT_DRIVE_PROPERTIES = {
  eTag: '"{file-1},1"',
  webDavUrl: "https://example.com/a.txt",
  name: "a.txt",
};
const tokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };

afterEach(() => vi.unstubAllGlobals());

type FetchCall = [string, RequestInit | undefined];

function requireFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): FetchCall {
  const call = fetchFn.mock.calls[index] as unknown as FetchCall | undefined;
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call;
}

function expectGraphUploadFetch(
  fetchFn: ReturnType<typeof vi.fn>,
  expectedUrl: string,
  contentType = "application/octet-stream",
): void {
  const [url, init] = requireFetchCall(fetchFn);
  const headers = new Headers(init?.headers);
  expect(url).toBe(expectedUrl);
  expect(init?.method).toBe("PUT");
  expect(headers.get("Authorization")).toBe("Bearer graph-token");
  expect(headers.get("Content-Type")).toBe(contentType);
  expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
}

function bodyOnlyErrorResponse(body: string, status = 500): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: new Response(body).body,
  } as unknown as Response;
}

type GraphRoute = {
  includes: string;
  respond: (init?: RequestInit) => Response | Promise<Response>;
};

function createGraphFetch(...routes: GraphRoute[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find((candidate) => url.includes(candidate.includes));
    if (!route) {
      throw new Error(`Unexpected SharePoint request: ${url}`);
    }
    return await route.respond(init);
  });
}

function fixedGraphRoute(includes: string, value: unknown, status = 200): GraphRoute {
  return {
    includes,
    respond: () =>
      typeof value === "string"
        ? new Response(value, { status })
        : Response.json(value, { status }),
  };
}

function successfulGraphRoutes(): GraphRoute[] {
  return [
    fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
    fixedGraphRoute("/members", { value: [{ userId: "user-1" }] }),
    fixedGraphRoute("/createLink", { link: { webUrl: "https://example.com/private" } }),
    fixedGraphRoute("/drive/items/item-1?", DEFAULT_DRIVE_PROPERTIES),
  ];
}

function revokeAfterRoute(includes: string, revoke: () => void) {
  return createGraphFetch(
    ...successfulGraphRoutes().map((route) => ({
      includes: route.includes,
      respond: async (init?: RequestInit) => {
        const response = await route.respond(init);
        if (route.includes === includes) {
          revoke();
        }
        return response;
      },
    })),
  );
}

function loopbackFetch(baseUrl: string) {
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestUrl(input));
    return await realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
  });
}

function createGraphSendAuthority() {
  const caller = new AbortController();
  const error = new Error("Teams send authority closed");
  return {
    error,
    revoke: () => caller.abort(error),
    handoff: {
      assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      onPlatformSendDispatch: vi.fn(async () => {}),
    },
  };
}

function hangingGraphRoute(includes: string): GraphRoute {
  return {
    includes,
    respond: async (init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected fetch AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => reject(abortReasonError(signal)), { once: true });
      }),
  };
}

function runGraphUpload(
  fetchFn: ReturnType<typeof vi.fn>,
  overrides: Partial<Parameters<typeof uploadAndShareSharePoint>[0]> = {},
): ReturnType<typeof uploadAndShareSharePoint> {
  vi.stubGlobal("fetch", withFetchPreconnect(fetchFn));
  return uploadAndShareSharePoint({
    buffer: DEFAULT_BUFFER,
    filename: DEFAULT_UPLOAD_RESULT.name,
    siteId: "site-123",
    tokenProvider,
    ...overrides,
  });
}

function uploadWithPerUserSharing(
  fetchFn: ReturnType<typeof vi.fn>,
  accessTokenProvider = tokenProvider,
) {
  return runGraphUpload(fetchFn, {
    chatId: "chat-123",
    usePerUserSharing: true,
    tokenProvider: accessTokenProvider,
  });
}

async function waitForFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): Promise<void> {
  await vi.waitFor(() => requireFetchCall(fetchFn, index));
}

function fetchSignal(fetchFn: ReturnType<typeof vi.fn>, index = 0): AbortSignal {
  const [, init] = requireFetchCall(fetchFn, index);
  const signal = (init as RequestInit | undefined)?.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new Error("Expected fetch AbortSignal");
  }
  return signal;
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("fetch request aborted");
}

function createHangingBodyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected fetch AbortSignal");
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const fail = () => controller.error(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", fail, { once: true });
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function createDelayedUploadFetch(value: unknown, delayMs: number): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected fetch AbortSignal");
    }
    return await new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortReasonError(signal)), { once: true });
      setTimeout(() => resolve(Response.json(value)), delayMs);
    });
  });
}

function expectMSTeamsTimeout(promise: Promise<unknown>, label: string, timeoutMs: number) {
  return expect(promise).rejects.toMatchObject({
    name: "TimeoutError",
    message: `${label} timed out after ${timeoutMs}ms`,
  });
}

type UploadToSharePointParams = Partial<
  Omit<Parameters<typeof uploadAndShareSharePoint>[0], "chatId" | "usePerUserSharing">
> & { fetchFn?: typeof fetch };

async function uploadToSharePoint({
  fetchFn = fetch,
  ...overrides
}: UploadToSharePointParams = {}) {
  const result = await runGraphUpload(
    vi.fn<typeof fetch>(async (input, init) =>
      requestUrl(input).endsWith("/createLink")
        ? Response.json({ link: { webUrl: "https://example.com/share" } })
        : await fetchFn(input, init),
    ),
    overrides,
  );
  return { id: result.itemId, webUrl: result.webUrl, name: result.name };
}

describe("graph upload helpers", () => {
  it("requires a non-empty SharePoint site ID", () => {
    expect(() => requireMSTeamsSharePointSiteId()).toThrow(
      "channels.msteams.sharePointSiteId is required",
    );
    expect(requireMSTeamsSharePointSiteId(" site-123 ")).toBe("site-123");
  });

  it("uploads the current bytes with the site drive path and PDF MIME", async () => {
    const contentType = "application/pdf";
    const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
    const buffer = backing.subarray(2, 5);
    const expectedBytes = Buffer.from([0, 0x80, 0xff]);
    const { promise: tokenReady, resolve: finishToken } = createDeferred<string>();
    const delayedTokenProvider = { getAccessToken: vi.fn(async () => await tokenReady) };
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      backing.fill(0);
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(expectedBytes);
      return Response.json({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" });
    });

    const upload = uploadToSharePoint({
      buffer,
      contentType,
      filename: "b.txt",
      tokenProvider: delayedTokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });
    await vi.waitFor(() => expect(delayedTokenProvider.getAccessToken).toHaveBeenCalledOnce());
    expect(fetchFn).not.toHaveBeenCalled();
    expectedBytes.copy(buffer);
    finishToken("graph-token");
    const result = await upload;

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content?@microsoft.graph.conflictBehavior=rename",
      contentType,
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("uploads with conflictBehavior=rename and surfaces the name SharePoint assigns", async () => {
    // Renaming avoids overwriting cached Teams cards for repeated asset names.
    const fetchFn = vi.fn(async () =>
      Response.json({ id: "item-9", webUrl: "https://example.com/9", name: "image-1 1.png" }),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("img"),
      filename: "image-1.png",
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expectGraphUploadFetch(
      fetchFn,
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/image-1.png:/content?@microsoft.graph.conflictBehavior=rename",
    );
    expect(result.name).toBe("image-1 1.png");
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(async () => Response.json({ id: "item-3" }));

    await expect(
      uploadToSharePoint({
        filename: "bad.txt",
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });

  it("bounds upload error bodies without requiring response.text()", async () => {
    const fetchFn = vi.fn(async () =>
      bodyOnlyErrorResponse(`${"upload-denied ".repeat(4096)}tail-marker`, 413),
    );

    const error = await uploadToSharePoint({
      filename: "large.txt",
      fetchFn: fetchFn as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("SharePoint upload failed (413): upload-denied");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });
});

describe("graph upload request timeouts", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds Graph token acquisition before starting an upload", async () => {
    vi.useFakeTimers();
    const hangingTokenProvider = {
      getAccessToken: vi.fn(async () => await new Promise<string>(() => {})),
    };
    const fetchFn = vi.fn();

    const upload = uploadToSharePoint({
      filename: "token-hang.txt",
      tokenProvider: hangingTokenProvider,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const assertion = expect(upload).rejects.toThrow(
      `MS Teams Graph token acquisition timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(hangingTokenProvider.getAccessToken).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sizes the SharePoint upload timeout for slow large transfers", async () => {
    vi.useFakeTimers();
    const timersBeforeUpload = vi.getTimerCount();
    const buffer = Buffer.alloc(1024 * 1024);
    const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
    const uploadResponse = {
      id: "item-large",
      webUrl: "https://example.com/large",
      name: "large.bin",
    };
    const fetchFn = createDelayedUploadFetch(
      uploadResponse,
      SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000,
    );
    const upload = uploadToSharePoint({
      buffer,
      filename: "large.bin",
      fetchFn: withFetchPreconnect(fetchFn),
    });
    await waitForFetchCall(fetchFn);
    const signal = fetchSignal(fetchFn);

    await vi.advanceTimersByTimeAsync(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(upload).resolves.toEqual(uploadResponse);
    expect(vi.getTimerCount()).toBe(timersBeforeUpload);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(vi.getTimerCount()).toBe(timersBeforeUpload);
    expect(abortReasonError(signal).name).not.toBe("TimeoutError");
    expect(timeoutMs).toBeGreaterThan(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000);
  });

  it.each([
    ["body", DEFAULT_BUFFER, 0],
    ["large transfer", Buffer.alloc(1024 * 1024), 0],
    ["members", DEFAULT_BUFFER, 1],
  ] as const)(
    "bounds a stalled %s request and aborts its signal",
    async (stage, buffer, requestIndex) => {
      vi.useFakeTimers();
      const fetchFn =
        stage === "body"
          ? createHangingBodyFetch()
          : createGraphFetch(
              ...(stage === "members" ? [fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT)] : []),
              hangingGraphRoute(stage === "members" ? "/members" : ""),
            );
      const timeoutMs =
        stage === "members"
          ? MSTEAMS_REQUEST_TIMEOUT_MS
          : resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
      const upload = runGraphUpload(fetchFn, {
        buffer,
        chatId: "chat-123",
        usePerUserSharing: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      await waitForFetchCall(fetchFn, requestIndex);
      const signal = fetchSignal(fetchFn, requestIndex);
      const assertion = expectMSTeamsTimeout(
        upload,
        stage === "members" ? "MS Teams SharePoint request" : "MS Teams SharePoint upload",
        timeoutMs,
      );
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await assertion;
      expect(signal.aborted).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(requestIndex + 1);
    },
  );

  it("creates a per-user link when member lookup succeeds", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", { value: [{ userId: "user-1" }, { userId: "user-2" }] }),
      fixedGraphRoute("/createLink", { link: { webUrl: "https://example.com/private" } }),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).resolves.toMatchObject({
      shareUrl: "https://example.com/private",
    });
    const [createLinkUrl, createLinkInit] = requireFetchCall(fetchFn, 2);
    expect(createLinkUrl).toContain("/beta/");
    expect((createLinkInit as RequestInit | undefined)?.body).toBe(
      JSON.stringify({
        type: "view",
        scope: "users",
        recipients: [{ objectId: "user-1" }, { objectId: "user-2" }],
      }),
    );
  });

  it.each([
    [503, "temporarily unavailable", { statusCode: 503 }],
    [
      403,
      "forbidden",
      { statusCode: 403, message: expect.stringContaining("verify Graph chat-member permissions") },
    ],
    [200, { value: [] }, "MS Teams chat member lookup returned no recipients"],
  ] as const)("fails closed for member lookup status=%s", async (status, body, expected) => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", body, status),
    );
    const rejected = expect(uploadWithPerUserSharing(fetchFn)).rejects;
    if (typeof expected === "string") {
      await rejected.toThrow(expected);
    } else {
      await rejected.toMatchObject(expected);
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the member lookup token provider rejects with 403", async () => {
    const tokenError = Object.assign(new Error("token unavailable"), { statusCode: 403 });
    const tokenProvider403 = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("graph-token")
        .mockRejectedValueOnce(tokenError)
        .mockResolvedValueOnce("graph-token"),
    };
    const fetchFn = createGraphFetch(fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT));

    await expect(uploadWithPerUserSharing(fetchFn, tokenProvider403)).rejects.toBe(tokenError);
    expect(tokenProvider403.getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("graph upload send authority", () => {
  function runPreparation(
    step: string,
    fetchFn: ReturnType<typeof vi.fn>,
    overrides: Partial<Parameters<typeof uploadAndShareSharePoint>[0]>,
  ) {
    vi.stubGlobal("fetch", withFetchPreconnect(fetchFn));
    return step === "properties"
      ? getDriveItemProperties({
          siteId: "site-123",
          itemId: "item-1",
          tokenProvider,
          ...overrides,
        })
      : runGraphUpload(fetchFn, {
          chatId: "chat-123",
          usePerUserSharing: true,
          ...overrides,
        });
  }

  it.each([
    { step: "upload", tokenCall: 1 },
    { step: "members", tokenCall: 2 },
    { step: "sharing", tokenCall: 3 },
    { step: "properties", tokenCall: 1 },
  ])("stops $step after authority closes during token acquisition", async ({ step, tokenCall }) => {
    const authority = createGraphSendAuthority();
    const tokenStarted = createDeferred<void>();
    const tokenReady = createDeferred<string>();
    let calls = 0;
    const delayedTokenProvider = {
      getAccessToken: vi.fn(async () => {
        if (++calls === tokenCall) {
          tokenStarted.resolve();
          return await tokenReady.promise;
        }
        return "graph-token";
      }),
    };
    const fetchFn = createGraphFetch(...successfulGraphRoutes());
    const operation = runPreparation(step, fetchFn, {
      tokenProvider: delayedTokenProvider,
      ...authority.handoff,
    });
    const assertion = expect(operation).rejects.toMatchObject({ cause: authority.error });

    await tokenStarted.promise;
    expect(fetchFn).toHaveBeenCalledTimes(tokenCall - 1);
    authority.revoke();
    tokenReady.resolve("graph-token");

    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(tokenCall - 1);
    expect(delayedTokenProvider.getAccessToken).toHaveBeenCalledTimes(tokenCall);
    expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { completed: "/content", requestCount: 1 },
    { completed: "/members", requestCount: 2 },
  ])(
    "stops the next preparation step after $completed settles under revoked authority",
    async ({ completed, requestCount }) => {
      const authority = createGraphSendAuthority();
      const accessTokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };
      const fetchFn = revokeAfterRoute(completed, authority.revoke);

      await expect(
        runPreparation("upload", fetchFn, {
          tokenProvider: accessTokenProvider,
          ...authority.handoff,
        }),
      ).rejects.toMatchObject({ cause: authority.error });
      expect(fetchFn).toHaveBeenCalledTimes(requestCount);
      expect(accessTokenProvider.getAccessToken).toHaveBeenCalledTimes(requestCount);
      expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      step: "sharing",
      finalRoute: "/createLink",
      expected: { shareUrl: "https://example.com/private" },
    },
    { step: "properties", finalRoute: "/drive/items/item-1?", expected: DEFAULT_DRIVE_PROPERTIES },
  ])(
    "retains the accepted $step response when authority closes before settlement",
    async ({ step, finalRoute, expected }) => {
      const authority = createGraphSendAuthority();
      const fetchFn = revokeAfterRoute(finalRoute, authority.revoke);

      await expect(runPreparation(step, fetchFn, authority.handoff)).resolves.toMatchObject(
        expected,
      );
      expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 307, redirectedStep: "upload" },
    { status: 307, redirectedStep: "createLink" },
  ])(
    "follows $status $redirectedStep redirects only while authority remains current",
    async ({ status, redirectedStep }) => {
      const requests: Array<{
        path: string;
        method: string;
        body: string;
        authorization?: string;
      }> = [];
      let authority = createGraphSendAuthority();
      let revokeOnRedirect = false;
      const uploadPath = "/v1.0/sites/site-123/drive/root:/OpenClawShared/a.txt:/content";
      const linkPath = "/v1.0/sites/site-123/drive/items/item-1/createLink";
      const redirectPath = `/redirected/${redirectedStep}`;

      await withServer(
        async (req, res) => {
          const body = await readBody(req);
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          requests.push({
            path,
            method: req.method ?? "GET",
            body,
            authorization: req.headers.authorization,
          });
          if (path === (redirectedStep === "upload" ? uploadPath : linkPath)) {
            if (revokeOnRedirect) {
              authority.revoke();
            }
            res.writeHead(status, { location: redirectPath });
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              path === uploadPath || (path === redirectPath && redirectedStep === "upload")
                ? DEFAULT_UPLOAD_RESULT
                : { link: { webUrl: "https://example.com/private" } },
            ),
          );
        },
        async (baseUrl) => {
          const fetchFn = loopbackFetch(baseUrl);

          await expect(runGraphUpload(fetchFn, authority.handoff)).resolves.toMatchObject({
            itemId: DEFAULT_UPLOAD_RESULT.id,
            shareUrl: "https://example.com/private",
          });
          const firstUpload = {
            path: uploadPath,
            method: "PUT",
            body: DEFAULT_BUFFER.toString(),
            authorization: "Bearer graph-token",
          };
          const firstLink = {
            path: linkPath,
            method: "POST",
            body: JSON.stringify({ type: "view", scope: "organization" }),
            authorization: "Bearer graph-token",
          };
          expect(requests).toEqual(
            redirectedStep === "upload"
              ? [firstUpload, { ...firstUpload, path: redirectPath }, firstLink]
              : [firstUpload, firstLink, { ...firstLink, path: redirectPath }],
          );
          expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();

          requests.length = 0;
          authority = createGraphSendAuthority();
          revokeOnRedirect = true;
          const outcome = await runGraphUpload(fetchFn, authority.handoff).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(requests).toEqual(
            redirectedStep === "upload" ? [firstUpload] : [firstUpload, firstLink],
          );
          expect(outcome).toMatchObject({ error: { cause: authority.error } });
          expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
        },
      );
    },
  );
});

it("rejects an oversized upload response from a real loopback server", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      Readable.from([
        '{"id":"item-big","webUrl":"https://example.com/big","name":"big.txt","padding":"',
        ...Array.from({ length: 257 }, () => chunk),
        '"}',
      ]).pipe(res);
    },
    async (baseUrl) => {
      vi.stubGlobal("fetch", withFetchPreconnect(loopbackFetch(baseUrl)));

      await expect(
        uploadToSharePoint({
          buffer: Buffer.from("x"),
          filename: "big.txt",
        }),
      ).rejects.toThrow(
        "msteams.graph-upload.uploadSharePointFile: JSON response exceeds 16777216 bytes",
      );
    },
  );
});

it.each([
  [
    '"{ABC-123},42"',
    "Quarterly.Report.PDF",
    "https://sharepoint.example.com/file.pdf",
    "ABC-123",
    "pdf",
  ],
  ["plain-etag", "README", "https://sharepoint.example.com/readme", "plain-etag", ""],
])("extracts id and extension from %s / %s", (eTag, name, url, uniqueId, fileType) => {
  expect(buildTeamsFileInfoCard({ eTag, name, webDavUrl: url })).toEqual({
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: url,
    name,
    content: { uniqueId, fileType },
  });
});
