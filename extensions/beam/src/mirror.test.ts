import type { IncomingMessage, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionCatalogRuntime from "openclaw/plugin-sdk/session-catalog-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleUpload } from "./beam-store.test-support.js";
import {
  beamMirrorTestFixture,
  beamTestMirrorConfig,
  beamTestNow,
  beamTestBarrier,
  beamTestServiceContext,
  beamTestSessions,
  createBeamTestCatalog,
  createBeamTestRunner,
  createScheduledBeamTestRunner,
  createBeamTestRuntime,
} from "./beam.test-support.js";
import {
  beamMirrorId,
  buildBeamMirrorItems,
  createBeamMirrorService,
  fitBeamMirrorUpload,
  parseBeamMirrorConfig,
} from "./mirror.js";
import { BEAM_MAX_ITEMS, parseBeamUpload } from "./types.js";

let fixture: ReturnType<typeof beamMirrorTestFixture>;
beforeEach(() => {
  fixture = beamMirrorTestFixture();
});

afterEach(() => vi.useRealTimers());

vi.mock("openclaw/plugin-sdk/session-catalog-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-catalog-runtime")>();
  return { ...actual, listActiveSessionCatalogs: vi.fn(actual.listActiveSessionCatalogs) };
});

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

  it.each([
    { bogus: true },
    { endpoint: "ftp://x" },
    { endpoint: "not a url" },
    { endpoint: "http://team.example/x" },
    { catalogs: [] },
  ])("rejects invalid mirror settings %j", (overrides) => {
    expect(typeof parseBeamMirrorConfig(beamTestMirrorConfig(overrides))).toBe("string");
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
    const upload = sampleUpload({
      title: "big",
      items: Array.from({ length: 300 }, (_, index) => ({
        type: "agentMessage" as const,
        text: `entry ${index} ${"🙂\n\u0000".repeat(200)}`,
      })),
    });
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
        };
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
    const { sent } = fixture;
    const reads: string[] = [];
    const cancel = vi.fn();
    const chronological = Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
      text: `Message ${index}: ${"text ".repeat(300)}end`,
    }));
    const runner = fixture.runner(
      {
        sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: beamTestNow - 60_000 }],
        items: chronological.toReversed(),
        onRead: (threadId) => reads.push(threadId),
      },
      { runtime: createBeamTestRuntime(beamTestMirrorConfig({ token: "scratch-token" })) },
      { cancel },
    );
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
    const { sent } = fixture;
    const runner = fixture.runner({
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

  it("marks the upload truncated when the source already truncated a message", async () => {
    const { sent } = fixture;
    const runner = fixture.runner({
      items: [{ type: "userMessage", text: "Partial message", truncated: true }],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      truncated: true,
      items: [{ type: "userMessage", text: "Partial message" }],
    });
    expect(parseBeamUpload(structuredClone(sent[0]?.payload)).ok).toBe(true);
  });

  it("keeps successful uploads successful when response cancellation rejects", async () => {
    const { sent, warnings } = fixture;
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const runner = fixture.runner(
      { sessions: [{ threadId: "t1", recencyAt: beamTestNow - 60_000 }] },
      {},
      { cancel },
    );

    await runner.tick();
    await runner.tick();

    expect(sent).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("keeps one catalog and upload path active across missed scheduler periods", async () => {
    vi.useFakeTimers();
    const list = beamTestBarrier();
    const read = vi.fn();
    const { sent } = fixture;
    const runner = fixture.scheduled({ onList: list.run, onRead: read });

    try {
      const first = runner.tick();
      await list.started;
      await first;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(list.run).toHaveBeenCalledOnce();

      list.release();
      await runner.settled;

      expect(read).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(1);
    } finally {
      list.release();
      await runner.stop();
    }
  });

  it("waits for guarded response cleanup after lifecycle abort without warning", async () => {
    vi.useFakeTimers();
    const fetchStarted = createDeferred<void>();
    const cleanup = beamTestBarrier();
    const cancel = vi.fn();
    const { warnings, logger } = fixture;
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
          release: cleanup.run,
        };
      });
    const runner = createScheduledBeamTestRunner({
      logger,
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
      await cleanup.started;
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      cleanup.release();
      await Promise.all([tick, stop]);

      expect(cancel).toHaveBeenCalledOnce();
      expect(cleanup.run).toHaveBeenCalledOnce();
      expect(warnings).toEqual([]);
    } finally {
      cleanup.release();
      guardedFetch.mockRestore();
      await runner.stop();
    }
  });

  it("aborts a stalled loopback transport on stop", async () => {
    vi.useFakeTimers();
    const requestStarted = createDeferred<void>();
    const requestClosed = createDeferred<void>();
    await withServer(
      (req) => {
        requestStarted.resolve();
        req.socket.once("close", requestClosed.resolve);
      },
      async (origin) => {
        const { warnings, logger } = fixture;
        let signal: AbortSignal | undefined;
        const realFetch = fetch;
        const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return realFetch(input, init);
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", fetchFn);
        const runner = createScheduledBeamTestRunner({
          endpoint: `${origin}/beam`,
          logger,
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
    const { sent } = fixture;
    const catalogs = [
      createBeamTestCatalog({ sessions: beamTestSessions(["old"], beamTestNow - 86_400_000) }),
      createBeamTestCatalog({ id: "codex", hostKind: "node" }),
      createBeamTestCatalog({ id: "beam" }),
      createBeamTestCatalog({ id: "pi" }),
    ];
    const runner = fixture.runner({}, { listCatalogs: () => catalogs });
    await runner.tick();
    expect(sent).toHaveLength(0);
  });

  it("warns once when profile isolation disables process-HOME fallback", async () => {
    const { warnings } = fixture;
    const runner = createBeamTestRunner({
      runtime: createBeamTestRuntime(beamTestMirrorConfig({ catalogs: ["claude"] })),
      logger: fixture.logger,
      listCatalogs: () => [
        createBeamTestCatalog({ sessions: [], processHomeFallbackAllowed: false }),
      ],
    });

    await runner.tick();
    await runner.tick();

    expect(warnings).toEqual([
      "beam mirror process-HOME fallback disabled: isolated state; only explicit catalog roots can be mirrored",
    ]);
  });

  it("sends one completed upload for an observed idle session on a partial host page", async () => {
    const { sent } = fixture;
    const recency = beamTestNow - 60_000;
    let clock = beamTestNow;
    const runner = fixture.runner(
      {
        hostCursor: "older-sessions",
        sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: recency }],
      },
      { now: () => clock },
    );
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

  it("skips ticks when a configured token cannot be resolved", async () => {
    const { sent } = fixture;
    const runner = fixture.runner(
      {},
      {
        runtime: createBeamTestRuntime(
          beamTestMirrorConfig({
            token: { source: "env", provider: "default", id: "BEAM_MISSING_TOKEN" },
          }),
        ),
      },
    );
    await runner.tick();
    expect(sent).toHaveLength(0);
  });
});

describe("createBeamMirrorService", () => {
  it.each(["list", "read"] as const)(
    "stops before a paused %s settles without resuming work",
    async (stage) => {
      vi.useFakeTimers();
      const context = beamTestServiceContext(),
        pause = beamTestBarrier();
      const list = stage === "list" ? pause.run : vi.fn();
      const read = stage === "read" ? pause.run : vi.fn();
      const catalogs = vi
        .spyOn(sessionCatalogRuntime, "listActiveSessionCatalogs")
        .mockReturnValue([
          createBeamTestCatalog({
            sessions: beamTestSessions(["t1", "t2"], Date.now()),
            onList: list,
            onRead: read,
          }),
        ]);
      const upload = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
        response: new Response("{}", { status: 200 }),
        finalUrl: "https://team.example/api/v1/beam/sessions",
        release: vi.fn(async () => undefined),
      });
      const service = createBeamMirrorService({
        runtime: createBeamTestRuntime(beamTestMirrorConfig()),
      });
      try {
        await service.start(context);
        const tick = vi.advanceTimersByTimeAsync(0);
        await pause.started;
        const stop = context.scheduler.stop();
        expect(context.scheduler.stop()).toBe(stop);
        await Promise.all([tick, stop]);
        expect(read).toHaveBeenCalledTimes(stage === "read" ? 1 : 0);
        expect(upload).not.toHaveBeenCalled();
        pause.release();
        await pause.run.mock.results[0]?.value;
        await vi.advanceTimersByTimeAsync(0);
        expect(list).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledTimes(stage === "read" ? 1 : 0);
        expect(upload).not.toHaveBeenCalled();
        expect(context.logger.warn).not.toHaveBeenCalled();
      } finally {
        pause.release();
        upload.mockRestore();
        catalogs.mockRestore();
        await context.scheduler.stop();
      }
    },
  );
});
