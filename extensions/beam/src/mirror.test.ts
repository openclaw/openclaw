import type { IncomingMessage, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import * as sessionCatalogRuntime from "openclaw/plugin-sdk/session-catalog-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  beamTestLogger,
  beamTestMirrorConfig,
  beamTestNow,
  createBeamTestCatalog,
  createBeamTestRunner,
  createBeamTestRuntime,
} from "./beam.test-support.js";
import {
  beamMirrorId,
  buildBeamMirrorItems,
  createBeamMirrorService,
  fitBeamMirrorUpload,
  parseBeamMirrorConfig,
} from "./mirror.js";
import { BEAM_MAX_ITEMS, parseBeamUpload, type BeamUpload } from "./types.js";

vi.mock("openclaw/plugin-sdk/session-catalog-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-catalog-runtime")>();
  return { ...actual, listActiveSessionCatalogs: vi.fn(actual.listActiveSessionCatalogs) };
});

type SentRequest = { url: string; auth?: string; payload: BeamUpload };

function captureFetch(
  sent: SentRequest[],
  status = 200,
  onCancel?: () => void | Promise<void>,
): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(url),
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
      payload: JSON.parse(init?.body as string) as BeamUpload,
    });
    const body = onCancel
      ? new ReadableStream<Uint8Array>({
          cancel: onCancel,
        })
      : "{}";
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withMirrorServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (origin: string) => Promise<void>,
) {
  await withServer((req, res) => {
    void readRequestBody(req).then(
      (body) => respond(req, res, body),
      (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  }, run);
}

describe("parseBeamMirrorConfig", () => {
  it("returns undefined without mirror config", () => {
    expect(parseBeamMirrorConfig({ plugins: { entries: { beam: { enabled: true } } } })).toBe(
      undefined,
    );
  });

  it("applies defaults and normalizes catalogs", () => {
    const parsed = parseBeamMirrorConfig(beamTestMirrorConfig({ catalogs: [" Claude "] }));
    expect(parsed).toMatchObject({
      endpoint: "https://team.example/api/v1/beam/sessions",
      catalogs: ["claude"],
      pollSeconds: 30,
      activeWindowMinutes: 180,
    });
  });

  it.each([
    { bogus: true },
    { endpoint: "ftp://x" },
    { endpoint: "not a url" },
    { endpoint: "http://team.example/x" },
    { catalogs: undefined },
    { catalogs: [] },
  ])("rejects invalid mirror settings %j", (overrides) => {
    expect(typeof parseBeamMirrorConfig(beamTestMirrorConfig(overrides))).toBe("string");
  });

  it.each(["http://127.0.0.1:19351/x", "http://localhost:19351/x", "http://[::1]:19351/x"])(
    "accepts plaintext loopback endpoint %s",
    (endpoint) => {
      expect(parseBeamMirrorConfig(beamTestMirrorConfig({ endpoint }))).toMatchObject({ endpoint });
    },
  );

  it("bounds poll and window values", () => {
    const parsed = parseBeamMirrorConfig(
      beamTestMirrorConfig({ pollSeconds: 1, activeWindowMinutes: 999_999 }),
    );
    expect(parsed).toMatchObject({ pollSeconds: 10, activeWindowMinutes: 10_080 });
  });
});

describe("buildBeamMirrorItems", () => {
  it("restores chronological text from newest-first catalog items and summarizes raw content", () => {
    const reduced = buildBeamMirrorItems([
      { type: "agentMessage", text: "Done." },
      { type: "reasoning", text: "private thoughts" },
      { type: "toolResult", raw: { output: "secret output" } },
      { type: "toolCall", text: "rm -rf /tmp/x", raw: { command: "secret" } },
      { type: "userMessage", text: "Fix it." },
    ]);
    expect(reduced.items).toEqual([
      { type: "userMessage", text: "Fix it." },
      {
        type: "other",
        text: "1 tool calls, 1 tool results, 1 reasoning items; raw content dropped",
      },
      { type: "agentMessage", text: "Done." },
    ]);
    expect(JSON.stringify(reduced.items)).not.toContain("secret");
    expect(JSON.stringify(reduced.items)).not.toContain("private thoughts");
  });
});

describe("fitBeamMirrorUpload", () => {
  it("fits the newest suffix with multibyte and JSON-escaped text", () => {
    const upload: BeamUpload = {
      version: 1,
      beamId: "0123456789abcdef0123456789abcdef",
      source: "claude",
      title: "big",
      updatedAt: "2026-07-27T12:00:00.000Z",
      completed: false,
      items: Array.from({ length: 300 }, (_, index) => ({
        type: "agentMessage" as const,
        text: `entry ${index} ${"🙂\n\u0000".repeat(200)}`,
      })),
    };
    const fitted = fitBeamMirrorUpload(upload);
    expect(fitted.truncated).toBe(true);
    expect(fitted.items.length).toBeLessThanOrEqual(BEAM_MAX_ITEMS);
    expect(fitted.items).toEqual(upload.items.slice(-fitted.items.length));
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(56 * 1024);
    // The fitted payload must remain acceptable to the receiver.
    expect(parseBeamUpload(structuredClone(fitted)).ok).toBe(true);
  });
});

describe("createBeamMirrorRunner", () => {
  it("does not replay mirror uploads across redirects to another private origin", async () => {
    const redirectedBodies: string[] = [];
    const receiverBodies: string[] = [];
    await withMirrorServer(
      (_req, res, body) => {
        redirectedBodies.push(body);
        res.end("ok");
      },
      async (internalOrigin) => {
        await withMirrorServer(
          (_req, res, body) => {
            receiverBodies.push(body);
            res.writeHead(307, { Location: `${internalOrigin}/internal-action` });
            res.end();
          },
          async (receiverOrigin) => {
            const runner = createBeamTestRunner({
              endpoint: `${receiverOrigin}/beam`,
              listCatalogs: () => [createBeamTestCatalog()],
            });
            await runner.tick();
            expect(receiverBodies).toHaveLength(1);
            expect(receiverBodies[0]).toContain("Fix the flow.");
            expect(redirectedBodies).toEqual([]);
          },
        );
      },
    );
  });

  it("blocks a redirect without retrying the configured endpoint or logging its location", async () => {
    const warnings: string[] = [];
    const receiverBodies: string[] = [];
    const redirectedBodies: string[] = [];
    await withMirrorServer(
      (req, res, body) => {
        if (req.url?.startsWith("/redirected")) {
          redirectedBodies.push(body);
          res.end("ok");
          return;
        }
        receiverBodies.push(body);
        res.writeHead(301, { Location: "/redirected?private=do-not-log" });
        res.end();
      },
      async (origin) => {
        const runner = createBeamTestRunner({
          endpoint: `${origin}/beam`,
          logger: { warn: (message) => warnings.push(message), info: () => {} },
          listCatalogs: () => [createBeamTestCatalog()],
        });
        await runner.tick();
        await runner.tick();
        expect(receiverBodies).toHaveLength(1);
        expect(redirectedBodies).toEqual([]);
        expect(warnings).toEqual([
          "beam mirror upload blocked for claude: receiver returned redirect (301); redirects are not followed; configure the final endpoint",
        ]);
        expect(warnings.join(" ")).not.toContain("do-not-log");
      },
    );
  });

  it("logs a terminal redirect block after a recent transient warning", async () => {
    const warnings: string[] = [];
    let requestCount = 0;
    await withMirrorServer(
      (_req, res) => {
        requestCount += 1;
        res.statusCode = requestCount === 1 ? 503 : 307;
        res.end();
      },
      async (origin) => {
        const runner = createBeamTestRunner({
          endpoint: `${origin}/beam`,
          logger: { warn: (message) => warnings.push(message), info: () => {} },
          listCatalogs: () => [createBeamTestCatalog()],
        });
        await runner.tick();
        await runner.tick();
        await runner.tick();
        expect(requestCount).toBe(2);
        expect(warnings).toEqual([
          "beam mirror upload failed (503) for claude",
          "beam mirror upload blocked for claude: receiver returned redirect (307); redirects are not followed; configure the final endpoint",
        ]);
      },
    );
  });

  it("rechecks once after runner restart and resumes after the endpoint changes", async () => {
    const requests: string[] = [];
    await withMirrorServer(
      (req, res) => {
        requests.push(req.url ?? "");
        if (req.url === "/redirecting") {
          res.writeHead(307, { Location: "/redirected" });
        }
        res.end();
      },
      async (origin) => {
        let endpoint = `${origin}/redirecting`;
        const runtime = {
          config: { current: () => beamTestMirrorConfig({ endpoint }) },
        } as unknown as PluginRuntime;
        let active = true;
        const createRunner = () =>
          createBeamTestRunner({
            runtime,
            listCatalogs: () => [
              createBeamTestCatalog({
                sessions: () => (active ? [{ threadId: "t1", recencyAt: beamTestNow }] : []),
              }),
            ],
          });
        const runner = createRunner();
        await runner.tick();
        await runner.tick();
        const restartedRunner = createRunner();
        await restartedRunner.tick();
        endpoint = `${origin}/direct`;
        await restartedRunner.tick();
        await restartedRunner.tick();
        endpoint = `${origin}/another-receiver`;
        active = false;
        await restartedRunner.tick();
        expect(requests).toEqual(["/redirecting", "/redirecting", "/direct"]);
        active = true;
        await restartedRunner.tick();
        await restartedRunner.tick();
        endpoint = `${origin}/direct`;
        await restartedRunner.tick();
        expect(requests).toEqual([
          "/redirecting",
          "/redirecting",
          "/direct",
          "/another-receiver",
          "/direct",
        ]);
      },
    );
  });

  it("uploads the newest chronological suffix of a large transcript once", async () => {
    const count = 50;
    const sent: SentRequest[] = [];
    const reads: string[] = [];
    const cancel = vi.fn();
    const chronological = Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
      text: `Message ${index}: ${"text ".repeat(300)}end`,
    }));
    const catalog = createBeamTestCatalog({
      sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: beamTestNow - 60_000 }],
      items: chronological.toReversed(),
      onRead: (threadId) => reads.push(threadId),
    });
    const runner = createBeamTestRunner({
      runtime: createBeamTestRuntime(beamTestMirrorConfig({ token: "scratch-token" })),
      fetchFn: captureFetch(sent, 200, cancel),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(reads).toEqual(["t1", "t1"]);
    expect(sent[0]?.auth).toBe("Bearer scratch-token");
    expect(sent[0]?.payload).toMatchObject({
      version: 1,
      beamId: beamMirrorId("claude", "gateway:local", "t1"),
      source: "claude",
      title: "Fix flow",
      completed: false,
    });
    expect(parseBeamUpload(structuredClone(sent[0]?.payload)).ok).toBe(true);
    const payload = sent[0]!.payload;
    expect(payload.items).toEqual(chronological.slice(-payload.items.length));
    expect(payload.truncated).toBe(true);
    expect(payload.items.length).toBeLessThan(count);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("includes the latest source model without changing the sanitized message payload", async () => {
    const sent: SentRequest[] = [];
    const catalog = createBeamTestCatalog({
      sessions: [
        {
          threadId: "t-model",
          name: "Model source",
          modelProvider: "openai",
          recencyAt: beamTestNow,
        },
      ],
      items: [
        { type: "agentMessage", text: "Latest", model: "gpt-5.6-sol" },
        { type: "agentMessage", text: "Earlier", model: "gpt-5.6-terra" },
        { type: "userMessage", text: "Continue this" },
      ],
    });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [catalog],
    });

    await runner.tick();

    expect(sent[0]?.payload.sourceModel).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    expect(sent[0]?.payload.items).toEqual([
      { type: "userMessage", text: "Continue this" },
      { type: "agentMessage", text: "Earlier" },
      { type: "agentMessage", text: "Latest" },
    ]);
  });

  it("does not split a surrogate pair when clipping the session title", async () => {
    const sent: SentRequest[] = [];
    const catalog = createBeamTestCatalog({
      sessions: [
        { threadId: "t-emoji", name: `${"x".repeat(159)}🙂`, recencyAt: beamTestNow - 60_000 },
      ],
    });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.title).toBe("x".repeat(159));
  });

  it.each([
    {
      reason: "the source already truncated a message",
      item: { type: "userMessage", text: "Partial message", truncated: true },
      expectedText: "Partial message",
    },
    {
      reason: "a message exceeds the receiver character cap",
      item: { type: "userMessage", text: "x".repeat(10_000) },
      expectedText: "x".repeat(6_000),
    },
    {
      reason: "clipping reaches a surrogate pair",
      item: { type: "userMessage", text: `${"x".repeat(5_999)}🙂tail` },
      expectedText: "x".repeat(5_999),
    },
  ] satisfies Array<{
    reason: string;
    item: SessionCatalogTranscriptItem;
    expectedText: string;
  }>)("marks the upload truncated when $reason", async ({ item, expectedText }) => {
    const sent: SentRequest[] = [];
    const catalog = createBeamTestCatalog({ items: [item] });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      truncated: true,
      items: [{ type: "userMessage", text: expectedText }],
    });
    expect(parseBeamUpload(structuredClone(sent[0]?.payload)).ok).toBe(true);
  });

  it("publishes a changed truncation flag even when the visible text is unchanged", async () => {
    const sent: SentRequest[] = [];
    const catalog = createBeamTestCatalog();
    const read = catalog.read;
    let hasOlderPage = false;
    catalog.read = async (request) => ({
      ...(await read(request)),
      ...(hasOlderPage ? { nextCursor: "older-page" } : {}),
    });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    hasOlderPage = true;
    await runner.tick();
    await runner.tick();
    expect(sent.map(({ payload }) => payload.truncated === true)).toEqual([false, true]);
    expect(sent[0]?.payload.items).toEqual(sent[1]?.payload.items);
  });

  it("redacts credentials from the uploaded title and visible messages while preserving prose", async () => {
    const token = `sk-${"synthetic".repeat(5)}`;
    const sent: SentRequest[] = [];
    const catalog = createBeamTestCatalog({
      sessions: [{ threadId: "t1", name: `Review credential ${token}`, recencyAt: beamTestNow }],
      items: [
        { type: "agentMessage", text: `Credential ${token} was found in configuration.` },
        { type: "userMessage", text: `Use ${token} to inspect the gateway.` },
      ],
    });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.payload)).not.toContain(token);
    expect(sent[0]?.payload).toMatchObject({
      title: expect.stringContaining("Review credential"),
      items: [
        { type: "userMessage", text: expect.stringContaining("inspect the gateway") },
        { type: "agentMessage", text: expect.stringContaining("was found in configuration") },
      ],
    });
  });

  it("keeps successful uploads successful when response cancellation rejects", async () => {
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const catalog = createBeamTestCatalog({
      sessions: [{ threadId: "t1", recencyAt: beamTestNow - 60_000 }],
    });
    const runner = createBeamTestRunner({
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      fetchFn: captureFetch(sent, 200, cancel),
      listCatalogs: () => [catalog],
    });

    await runner.tick();
    await runner.tick();

    expect(sent).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("bounds guarded uploads and releases their response resources", async () => {
    const cancel = vi.fn();
    const release = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      { status: 200 },
    );
    const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response,
      finalUrl: "https://team.example/api/v1/beam/sessions",
      release,
    });
    const runner = createBeamTestRunner({
      listCatalogs: () => [createBeamTestCatalog()],
    });

    try {
      await runner.tick();

      expect(guardedFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://team.example/api/v1/beam/sessions",
          timeoutMs: 15_000,
          maxRedirects: 0,
          policy: { allowedOrigins: ["https://team.example"] },
        }),
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      guardedFetch.mockRestore();
    }
  });

  it("stops before a paused transcript read settles without resuming mirror work", async () => {
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const list = vi.fn();
    const read = vi.fn(async () => {
      readStarted.resolve();
      await releaseRead.promise;
    });
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const runner = createBeamTestRunner({
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      fetchFn: captureFetch(sent),
      listCatalogs: () => [
        createBeamTestCatalog({
          sessions: [
            { threadId: "t1", recencyAt: beamTestNow },
            { threadId: "t2", recencyAt: beamTestNow },
          ],
          onList: list,
          onRead: read,
        }),
      ],
    });

    try {
      const tick = runner.tick();
      await readStarted.promise;
      const firstStop = runner.stop();
      expect(runner.stop()).toBe(firstStop);
      await Promise.all([firstStop, tick]);

      releaseRead.resolve();
      await read.mock.results[0]?.value;

      expect(read).toHaveBeenCalledOnce();
      expect(sent).toEqual([]);
      expect(warnings).toEqual([]);
      await runner.tick();
      expect(list).toHaveBeenCalledOnce();
    } finally {
      releaseRead.resolve();
      await runner.stop();
    }
  });

  it("joins overlapping ticks into one catalog and upload path", async () => {
    const listStarted = createDeferred<void>();
    const releaseList = createDeferred<void>();
    const list = vi.fn(async () => {
      listStarted.resolve();
      await releaseList.promise;
    });
    const read = vi.fn();
    const sent: SentRequest[] = [];
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [
        createBeamTestCatalog({
          onList: list,
          onRead: read,
        }),
      ],
    });

    try {
      const first = runner.tick();
      await listStarted.promise;
      const second = runner.tick();
      await Promise.resolve();
      expect(list).toHaveBeenCalledOnce();

      releaseList.resolve();
      await Promise.all([first, second]);

      expect(read).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(1);
    } finally {
      releaseList.resolve();
      await runner.stop();
    }
  });

  it("waits for guarded response cleanup after lifecycle abort without warning", async () => {
    const fetchStarted = createDeferred<void>();
    const cleanupStarted = createDeferred<void>();
    const releaseCleanup = createDeferred<void>();
    const cancel = vi.fn();
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    const warnings: string[] = [];
    let signal: AbortSignal | undefined;
    const guardedFetch = vi
      .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
      .mockImplementation(async (options) => {
        const abortSignal = options.signal;
        fetchStarted.resolve();
        if (!abortSignal) {
          throw new Error("guarded fetch did not receive the runner abort signal");
        }
        signal = abortSignal;
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }),
          finalUrl: options.url,
          release,
        };
      });
    const runner = createBeamTestRunner({
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      listCatalogs: () => [createBeamTestCatalog()],
    });

    try {
      const tick = runner.tick();
      await fetchStarted.promise;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      let stopSettled = false;
      const stop = runner.stop().then(() => {
        stopSettled = true;
      });
      expect(signal?.aborted).toBe(true);
      await cleanupStarted.promise;
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      releaseCleanup.resolve();
      await Promise.all([tick, stop]);

      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(warnings).toEqual([]);
    } finally {
      releaseCleanup.resolve();
      guardedFetch.mockRestore();
      await runner.stop();
    }
  });

  it("aborts a stalled loopback transport on stop", async () => {
    const requestStarted = createDeferred<void>();
    const requestClosed = createDeferred<void>();
    await withServer(
      (req) => {
        requestStarted.resolve();
        req.socket.once("close", requestClosed.resolve);
      },
      async (origin) => {
        const warnings: string[] = [];
        let signal: AbortSignal | undefined;
        const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return fetch(input, init);
        }) as unknown as typeof fetch;
        const runner = createBeamTestRunner({
          endpoint: `${origin}/beam`,
          logger: { warn: (message) => warnings.push(message), info: () => {} },
          fetchFn,
          listCatalogs: () => [createBeamTestCatalog()],
        });

        try {
          const tick = runner.tick();
          await requestStarted.promise;
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal?.aborted).toBe(false);

          const stop = runner.stop();
          expect(signal?.aborted).toBe(true);
          await Promise.all([requestClosed.promise, tick, stop]);

          expect(warnings).toEqual([]);
        } finally {
          await runner.stop();
        }
      },
    );
  });

  it("ignores idle sessions, node hosts, the beam catalog, and unlisted catalogs", async () => {
    const sent: SentRequest[] = [];
    const idle = createBeamTestCatalog({
      sessions: [{ threadId: "old", recencyAt: beamTestNow - 24 * 60 * 60_000 }],
    });
    const nodeHost = createBeamTestCatalog({
      id: "codex",
      sessions: [{ threadId: "remote", recencyAt: beamTestNow }],
      hostKind: "node",
    });
    const beamCatalog = createBeamTestCatalog({
      id: "beam",
      sessions: [{ threadId: "loop", recencyAt: beamTestNow }],
    });
    const unlisted = createBeamTestCatalog({
      id: "pi",
      sessions: [{ threadId: "p1", recencyAt: beamTestNow }],
    });
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      listCatalogs: () => [idle, nodeHost, beamCatalog, unlisted],
    });
    await runner.tick();
    expect(sent).toHaveLength(0);
  });

  it("warns once when profile isolation disables process-HOME fallback", async () => {
    const warnings: string[] = [];
    const catalog = createBeamTestCatalog({
      sessions: [],
      processHomeFallbackAllowed: false,
    });
    const runner = createBeamTestRunner({
      runtime: createBeamTestRuntime(beamTestMirrorConfig({ catalogs: ["claude"] })),
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      listCatalogs: () => [catalog],
    });

    await runner.tick();
    await runner.tick();

    expect(warnings).toEqual([
      "beam mirror process-HOME fallback disabled: isolated state; only explicit catalog roots can be mirrored",
    ]);
  });

  it("sends one completed upload for an observed idle session on a partial host page", async () => {
    const sent: SentRequest[] = [];
    const recency = beamTestNow - 60_000;
    const catalog = createBeamTestCatalog({
      hostCursor: "older-sessions",
      sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: recency }],
    });
    let clock = beamTestNow;
    const runner = createBeamTestRunner({
      fetchFn: captureFetch(sent),
      now: () => clock,
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.completed).toBe(false);
    // Session goes idle past the window; the next tick finalizes it once.
    clock = beamTestNow + 4 * 60 * 60_000;
    await runner.tick();
    await runner.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload.completed).toBe(true);
    expect(sent[1]?.payload.beamId).toBe(sent[0]?.payload.beamId);
  });

  it("keeps tracking for retry when the receiver rejects an upload", async () => {
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const cancel = vi.fn();
    const catalog = createBeamTestCatalog({
      sessions: [{ threadId: "t1", recencyAt: beamTestNow - 60_000 }],
    });
    const runner = createBeamTestRunner({
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      fetchFn: captureFetch(sent, 503, cancel),
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    await runner.tick();
    // Both ticks retry because the failed upload was never fingerprinted.
    expect(sent).toHaveLength(2);
    expect(warnings.length).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("skips ticks when a configured token cannot be resolved", async () => {
    const sent: SentRequest[] = [];
    const runner = createBeamTestRunner({
      runtime: createBeamTestRuntime(
        beamTestMirrorConfig({
          token: { source: "env", provider: "default", id: "BEAM_MISSING_TOKEN" },
        }),
      ),
      env: {},
      fetchFn: captureFetch(sent),
      listCatalogs: () => [createBeamTestCatalog()],
    });
    await runner.tick();
    expect(sent).toHaveLength(0);
  });
});

describe("createBeamMirrorService", () => {
  it("stops before catalog listing settles without starting reads or uploads", async () => {
    const listingStarted = createDeferred<void>();
    const releaseListing = createDeferred<void>();
    const list = vi.fn(async () => {
      listingStarted.resolve();
      await releaseListing.promise;
    });
    const read = vi.fn();
    const catalog = createBeamTestCatalog({
      sessions: [{ threadId: "t1", recencyAt: Date.now() }],
      onList: list,
      onRead: read,
    });
    const listCatalogs = vi
      .spyOn(sessionCatalogRuntime, "listActiveSessionCatalogs")
      .mockReturnValue([catalog]);
    const upload = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response: new Response("{}", { status: 200 }),
      finalUrl: "https://team.example/api/v1/beam/sessions",
      release: vi.fn(async () => undefined),
    });
    const service = createBeamMirrorService({
      runtime: createBeamTestRuntime(beamTestMirrorConfig()),
    });

    try {
      service.start({ logger: beamTestLogger });
      await listingStarted.promise;

      await service.stop();
      expect(read).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();

      releaseListing.resolve();
      await list.mock.results[0]?.value;

      expect(read).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    } finally {
      releaseListing.resolve();
      upload.mockRestore();
      listCatalogs.mockRestore();
      await service.stop();
    }
  });
});
