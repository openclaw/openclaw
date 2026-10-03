import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type GraphFetch = ReturnType<typeof vi.fn<typeof fetch>>;

type FetchCall = [string, RequestInit | undefined];

function requireFetchCall(fetchFn: GraphFetch, index = 0): FetchCall {
  const call = fetchFn.mock.calls[index] as unknown as FetchCall | undefined;
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call;
}

function expectGraphUploadFetch(
  fetchFn: GraphFetch,
  expectedUrl: string,
  contentType = "application/octet-stream",
): void {
  const [url, init] = requireFetchCall(fetchFn);
  expect(url).toBe(expectedUrl);
  expect(init?.method).toBe("PUT");
  const headers = new Headers(init?.headers);
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

function createGraphFetch(...routes: GraphRoute[]): GraphFetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
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
    fixedGraphRoute("/members", { value: [{ userId: "user-1" }, { userId: "user-2" }] }),
    fixedGraphRoute("/createLink", { link: { webUrl: "https://example.com/private" } }),
    fixedGraphRoute("/drive/items/item-1?", DEFAULT_DRIVE_PROPERTIES),
  ];
}

function createGraphSendAuthority() {
  let current = true;
  const error = new Error("Teams send authority closed");
  return {
    error,
    revoke: () => {
      current = false;
    },
    handoff: {
      assertDirectAdapterHandoff: () => {
        if (!current) {
          throw error;
        }
      },
      onPlatformSendDispatch: vi.fn(async () => {}),
    },
  };
}

function timedGraphRoute(includes: string, mode: "headers" | "body" | number) {
  const started = createDeferred<AbortSignal>();
  const route: GraphRoute = {
    includes,
    respond: (init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expected fetch AbortSignal");
      }
      started.resolve(signal);
      if (mode === "body") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("fetch request aborted"),
            ),
          { once: true },
        );
        if (typeof mode === "number") {
          setTimeout(() => resolve(Response.json(DEFAULT_UPLOAD_RESULT)), mode);
        }
      });
    },
  };
  return { route, started: started.promise };
}

function runGraphUpload(
  fetchFn: GraphFetch,
  overrides: Partial<Parameters<typeof uploadAndShareSharePoint>[0]> = {},
): ReturnType<typeof uploadAndShareSharePoint> {
  return uploadAndShareSharePoint({
    buffer: DEFAULT_BUFFER,
    filename: DEFAULT_UPLOAD_RESULT.name,
    siteId: "site-123",
    tokenProvider,
    fetchFn: withFetchPreconnect(fetchFn),
    ...overrides,
  });
}

function uploadWithPerUserSharing(fetchFn: GraphFetch, accessTokenProvider = tokenProvider) {
  return runGraphUpload(fetchFn, {
    chatId: "chat-123",
    usePerUserSharing: true,
    tokenProvider: accessTokenProvider,
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
>;

async function uploadToSharePoint(params: UploadToSharePointParams = {}) {
  const uploadFetch = params.fetchFn ?? fetch;
  const fetchFn = withFetchPreconnect(
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/createLink")) {
        return Response.json({ link: { webUrl: "https://example.com/share" } });
      }
      return await uploadFetch(input, init);
    }),
  );
  const result = await runGraphUpload(fetchFn, { ...params, fetchFn });
  return { id: result.itemId, webUrl: result.webUrl, name: result.name };
}

describe("graph upload helpers", () => {
  it("requires a non-empty SharePoint site ID", () => {
    expect(() => requireMSTeamsSharePointSiteId()).toThrow(
      "channels.msteams.sharePointSiteId is required",
    );
    expect(requireMSTeamsSharePointSiteId(" site-123 ")).toBe("site-123");
  });

  it("snapshots upload bytes after token preparation and returns SharePoint's renamed file", async () => {
    const contentType = "application/pdf";
    const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
    const buffer = backing.subarray(2, 5);
    const expectedBytes = Buffer.from([0, 0x80, 0xff]);
    const { promise: tokenReady, resolve: finishToken } = createDeferred<string>();
    const tokenStarted = createDeferred<void>();
    const delayedTokenProvider = {
      getAccessToken: vi.fn(async () => {
        tokenStarted.resolve();
        return await tokenReady;
      }),
    };
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      backing.fill(0);
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(expectedBytes);
      return Response.json({ id: "item-2", webUrl: "https://example.com/2", name: "b 1.txt" });
    });

    const upload = uploadToSharePoint({
      buffer,
      contentType,
      filename: "b.txt",
      tokenProvider: delayedTokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });
    await tokenStarted.promise;
    expect(delayedTokenProvider.getAccessToken).toHaveBeenCalledOnce();
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
      name: "b 1.txt",
    });
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ id: "item-3" }));

    await expect(
      uploadToSharePoint({
        filename: "bad.txt",
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });

  it("bounds upload error bodies without requiring response.text()", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      bodyOnlyErrorResponse(`${"upload-denied ".repeat(4096)}tail-marker`, 413),
    );

    let error: unknown;
    try {
      await uploadToSharePoint({
        filename: "large.txt",
        fetchFn: withFetchPreconnect(fetchFn),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("SharePoint upload failed (413): upload-denied");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });
});

describe("graph upload request timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bounds Graph token acquisition before starting an upload", async () => {
    const hangingTokenProvider = {
      getAccessToken: vi.fn(async () => await new Promise<string>(() => {})),
    };
    const fetchFn = vi.fn<typeof fetch>();

    const upload = uploadToSharePoint({
      filename: "token-hang.txt",
      tokenProvider: hangingTokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });
    const assertion = expect(upload).rejects.toThrow(
      `MS Teams Graph token acquisition timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(hangingTokenProvider.getAccessToken).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { name: "large upload headers", path: "/content", mode: "headers", size: 1024 * 1024 },
    { name: "upload response body", path: "/content", mode: "body", size: 5 },
    { name: "member lookup", path: "/members", mode: "headers", size: 5 },
  ] as const)("aborts stalled $name without widening sharing", async ({ path, mode, size }) => {
    const pending = timedGraphRoute(path, mode);
    const fetchFn = createGraphFetch(
      pending.route,
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
    );
    const upload = runGraphUpload(fetchFn, {
      buffer: Buffer.alloc(size),
      chatId: "chat-123",
      usePerUserSharing: true,
    });
    const signal = await pending.started;
    const isUpload = path === "/content";
    const timeoutMs = isUpload
      ? resolveMSTeamsSharePointUploadTimeoutMs(size)
      : MSTEAMS_REQUEST_TIMEOUT_MS;
    const assertion = expectMSTeamsTimeout(
      upload,
      isUpload ? "MS Teams SharePoint upload" : "MS Teams SharePoint request",
      timeoutMs,
    );
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(timeoutMs)]);
    expect(signal.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(isUpload ? 1 : 2);
  });

  it("sizes the transfer budget for large uploads and releases completed deadlines", async () => {
    const timersBeforeUpload = vi.getTimerCount();
    const buffer = Buffer.alloc(1024 * 1024);
    const timeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
    const delayed = timedGraphRoute("/content", SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000);
    const fetchFn = createGraphFetch(delayed.route);
    const upload = uploadToSharePoint({ buffer, fetchFn: withFetchPreconnect(fetchFn) });
    const signal = await delayed.started;
    await vi.advanceTimersByTimeAsync(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(upload).resolves.toEqual(DEFAULT_UPLOAD_RESULT);
    expect(vi.getTimerCount()).toBe(timersBeforeUpload);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(vi.getTimerCount()).toBe(timersBeforeUpload);
    expect(signal.reason?.name).not.toBe("TimeoutError");
    expect(timeoutMs).toBeGreaterThan(SHAREPOINT_UPLOAD_BASE_TIMEOUT_MS + 1_000);
  });

  it.each([
    [503, "Get chat members failed"],
    [403, "verify Graph chat-member permissions"],
  ] as const)("fails closed on Graph member lookup HTTP %s", async (statusCode, message) => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", "unavailable", statusCode),
    );
    await expect(uploadWithPerUserSharing(fetchFn)).rejects.toMatchObject({
      statusCode,
      message: expect.stringContaining(message),
    });
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

  it("fails closed when member lookup returns no recipients", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("/content", DEFAULT_UPLOAD_RESULT),
      fixedGraphRoute("/members", { value: [] }),
    );

    await expect(uploadWithPerUserSharing(fetchFn)).rejects.toThrow(
      "MS Teams chat member lookup returned no recipients",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("graph upload send authority", () => {
  function runPreparation(
    step: string,
    fetchFn: GraphFetch,
    overrides: Partial<Parameters<typeof uploadAndShareSharePoint>[0]>,
  ) {
    return step === "properties"
      ? getDriveItemProperties({
          siteId: "site-123",
          itemId: "item-1",
          tokenProvider,
          fetchFn: withFetchPreconnect(fetchFn),
          ...overrides,
        })
      : runGraphUpload(fetchFn, {
          chatId: "chat-123",
          usePerUserSharing: true,
          ...overrides,
        });
  }

  function revokeAfter(routePath: string, revoke: () => void) {
    return createGraphFetch(
      ...successfulGraphRoutes().map((route) => ({
        includes: route.includes,
        respond: async (init?: RequestInit) => {
          const response = await route.respond(init);
          if (route.includes === routePath) {
            revoke();
          }
          return response;
        },
      })),
    );
  }

  it.each([
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

  it("stops sharing before token acquisition when member lookup closes authority", async () => {
    const authority = createGraphSendAuthority();
    const accessTokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };
    const fetchFn = revokeAfter("/members", authority.revoke);

    await expect(
      runPreparation("upload", fetchFn, {
        tokenProvider: accessTokenProvider,
        ...authority.handoff,
      }),
    ).rejects.toMatchObject({ cause: authority.error });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(accessTokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
  });

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
      const fetchFn = revokeAfter(finalRoute, authority.revoke);

      await expect(runPreparation(step, fetchFn, authority.handoff)).resolves.toMatchObject(
        expected,
      );
      if (step === "sharing") {
        const [url, init] = requireFetchCall(fetchFn, 2);
        expect(url).toContain("/beta/");
        expect(init?.body).toBe(
          JSON.stringify({
            type: "view",
            scope: "users",
            recipients: [{ objectId: "user-1" }, { objectId: "user-2" }],
          }),
        );
      }
      expect(authority.handoff.onPlatformSendDispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 307, redirectedStep: "upload" },
    { status: 308, redirectedStep: "createLink" },
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
        (req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            requests.push({
              path,
              method: req.method ?? "GET",
              body: Buffer.concat(chunks).toString(),
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
          });
        },
        async (baseUrl) => {
          const realFetch = globalThis.fetch.bind(globalThis);
          const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            // Map only the URL: baseline fetch must retain its native automatic redirects.
            return await realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
          });

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

describe("graph upload response limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an oversized upload response from a real loopback server", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let remaining = 257; // >16 MiB when combined with the JSON prefix.
        res.write(
          '{"id":"item-big","webUrl":"https://example.com/big","name":"big.txt","padding":"',
        );
        const writeNext = () => {
          if (remaining <= 0) {
            res.end('"}');
            return;
          }
          remaining -= 1;
          if (res.write(chunk)) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
      },
      async (baseUrl) => {
        const realFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal(
          "fetch",
          withFetchPreconnect(
            vi.fn<typeof fetch>(async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              const loopback = new URL(`${url.pathname}${url.search}`, baseUrl);
              return realFetch(loopback, init);
            }),
          ),
        );

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
});

describe("buildTeamsFileInfoCard", () => {
  it.each([
    ['"{ABC-123},42"', "Quarterly.Report.PDF", "ABC-123", "pdf"],
    ["plain-etag", "README", "plain-etag", ""],
  ])("formats %s / %s", (eTag, name, uniqueId, fileType) => {
    const webDavUrl = "https://sharepoint.example.com/file";
    expect(buildTeamsFileInfoCard({ eTag, name, webDavUrl })).toEqual({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: webDavUrl,
      name,
      content: { uniqueId, fileType },
    });
  });
});
