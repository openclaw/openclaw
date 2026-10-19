import type { IncomingMessage, ServerResponse } from "node:http";
import { text as readRequestBody } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import * as sessionCatalogRuntime from "openclaw/plugin-sdk/session-catalog-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleUpload } from "./beam-store.test-support.js";
import {
  beamTestLogger,
  beamTestMirrorConfig,
  beamTestNow,
  beamMirrorTestFixture,
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

const releases: Array<() => void> = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  for (const stop of stops.splice(0)) {
    await stop();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

vi.mock("openclaw/plugin-sdk/session-catalog-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-catalog-runtime")>();
  return { ...actual, listActiveSessionCatalogs: vi.fn(actual.listActiveSessionCatalogs) };
});

type Fixture = ReturnType<typeof beamMirrorTestFixture>;
let fixture: Fixture;
let sent: Fixture["sent"];
let warnings: string[];
let logger: Fixture["logger"];
let testRunner: Fixture["runner"];
beforeEach(() => {
  fixture = beamMirrorTestFixture();
  ({ sent, warnings, logger, runner: testRunner } = fixture);
});

const scheduledRunner = (...args: Parameters<Fixture["scheduled"]>) => {
  const runner = fixture.scheduled(...args);
  stops.push(runner.stop);
  return runner;
};

function pausedCall() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  releases.push(release.resolve);
  const call = vi.fn(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: release.resolve, call };
}

function loopbackRunner(endpoint: string) {
  return createBeamTestRunner({ endpoint, logger, listCatalogs: () => [createBeamTestCatalog()] });
}
async function poll(runner: { tick: () => Promise<void> }, count = 2) {
  for (let index = 0; index < count; index++) {
    await runner.tick();
  }
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

it("fits the newest suffix with multibyte and JSON-escaped text", () => {
  const upload = sampleUpload({
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
  expect(parseBeamUpload(structuredClone(fitted)).ok).toBe(true);
});

describe("createBeamMirrorRunner", () => {
  it.each([
    { destination: "private origin", statuses: [307] },
    { destination: "relative path", statuses: [301] },
    { destination: "no location after transient failure", statuses: [503, 307] },
  ])(
    "blocks $destination redirects, retries, and location disclosure",
    async ({ destination, statuses }) => {
      const redirected: string[] = [];
      const received: string[] = [];
      const recordRedirect = (_req: IncomingMessage, res: ServerResponse, body: string) => {
        redirected.push(body);
        res.end("ok");
      };
      await withMirrorServer(recordRedirect, async (internal) => {
        await withMirrorServer(
          (req, res, body) => {
            if (req.url?.startsWith("/redirected")) {
              return recordRedirect(req, res, body);
            }
            const status = statuses[received.push(body) - 1] ?? 200;
            const location =
              destination === "private origin"
                ? `${internal}/internal-action`
                : "/redirected?private=do-not-log";
            res.writeHead(
              status,
              destination.startsWith("no location") ? {} : { Location: location },
            );
            res.end();
          },
          async (origin) => {
            const runner = loopbackRunner(`${origin}/beam`);
            await poll(runner, statuses.length + 1);
            expect(received).toHaveLength(statuses.length);
            expect(received[0]).toContain("Fix the flow.");
            expect(redirected).toEqual([]);
            expect(warnings).toEqual([
              ...(statuses.length === 2 ? ["beam mirror upload failed (503) for claude"] : []),
              `beam mirror upload blocked for claude: receiver returned redirect (${statuses.at(-1)}); redirects are not followed; configure the final endpoint`,
            ]);
            expect(warnings.join(" ")).not.toContain("do-not-log");
          },
        );
      });
    },
  );

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
        const catalog = createBeamTestCatalog({
          sessions: () => (active ? [{ threadId: "t1", recencyAt: beamTestNow }] : []),
        });
        const createRunner = () => createBeamTestRunner({ runtime, listCatalogs: () => [catalog] });
        const runner = createRunner();
        await poll(runner);
        const restartedRunner = createRunner();
        await restartedRunner.tick();
        endpoint = `${origin}/direct`;
        await poll(restartedRunner);
        endpoint = `${origin}/another-receiver`;
        active = false;
        await restartedRunner.tick();
        expect(requests).toEqual(["/redirecting", "/redirecting", "/direct"]);
        active = true;
        await poll(restartedRunner);
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
    const reads: string[] = [];
    const cancel = vi.fn();
    const chronological = Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
      text: `Message ${index}: ${"text ".repeat(300)}end`,
    }));
    const runner = testRunner(
      {
        sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: beamTestNow - 60_000 }],
        items: chronological.toReversed(),
        onRead: (threadId) => reads.push(threadId),
      },
      {
        runtime: createBeamTestRuntime(beamTestMirrorConfig({ token: "scratch-token" })),
      },
      { cancel },
    );
    await poll(runner);
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
    const session = { threadId: "t1", modelProvider: "openai", recencyAt: beamTestNow };
    const runner = testRunner({
      sessions: [session],
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
    const runner = testRunner({
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
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const runner = testRunner({}, {}, { cancel });

    await poll(runner);

    expect(sent).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("stops before a paused transcript read settles without resuming mirror work", async () => {
    vi.useFakeTimers();
    const list = vi.fn();
    const read = pausedCall();
    const runner = scheduledRunner({
      sessions: [
        { threadId: "t1", recencyAt: beamTestNow },
        { threadId: "t2", recencyAt: beamTestNow },
      ],
      onList: list,
      onRead: read.call,
    });

    const tick = runner.tick();
    await read.started;
    const firstStop = runner.stop();
    expect(runner.stop()).toBe(firstStop);
    await Promise.all([firstStop, tick]);
    read.release();
    await read.call.mock.results[0]?.value;
    expect(read.call).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(warnings).toEqual([]);
    await runner.tick();
    expect(list).toHaveBeenCalledOnce();
  });

  it("keeps one catalog and upload path active across missed scheduler periods", async () => {
    vi.useFakeTimers();
    const list = pausedCall();
    const read = vi.fn();
    const runner = scheduledRunner({ onList: list.call, onRead: read });

    const first = runner.tick();
    await list.started;
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list.call).toHaveBeenCalledOnce();
    list.release();
    await runner.settled;
    expect(read).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it("waits for guarded response cleanup after lifecycle abort without warning", async () => {
    vi.useFakeTimers();
    const fetchStarted = createDeferred<void>();
    const cancel = vi.fn();
    const cleanup = pausedCall();
    let signal: AbortSignal | undefined;
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (options) => {
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
        release: cleanup.call,
      };
    });
    const runner = scheduledRunner({}, { fetchFn: undefined });
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
    expect(cleanup.call).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
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
        let signal: AbortSignal | undefined;
        const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return fetch(input, init);
        }) as unknown as typeof fetch;
        const runner = createScheduledBeamTestRunner({
          endpoint: `${origin}/beam`,
          logger,
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
    const idle = createBeamTestCatalog({
      sessions: [{ threadId: "old", recencyAt: beamTestNow - 24 * 60 * 60_000 }],
    });
    const nodeHost = createBeamTestCatalog({
      id: "codex",
      hostKind: "node",
    });
    const beamCatalog = createBeamTestCatalog({ id: "beam" });
    const unlisted = createBeamTestCatalog({ id: "pi" });
    const runner = testRunner(
      {},
      {
        listCatalogs: () => [idle, nodeHost, beamCatalog, unlisted],
      },
    );
    await runner.tick();
    expect(sent).toHaveLength(0);
  });

  it("warns once when profile isolation disables process-HOME fallback", async () => {
    const isolatedCatalog = { sessions: [], processHomeFallbackAllowed: false };
    const runner = testRunner(isolatedCatalog, { fetchFn: undefined });

    await poll(runner);

    expect(warnings).toEqual([
      "beam mirror process-HOME fallback disabled: isolated state; only explicit catalog roots can be mirrored",
    ]);
  });

  it("sends one completed upload for an observed idle session on a partial host page", async () => {
    let clock = beamTestNow;
    const partialCatalog = { hostCursor: "older-sessions" };
    const runner = testRunner(partialCatalog, { now: () => clock });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.completed).toBe(false);
    clock = beamTestNow + 4 * 60 * 60_000;
    await poll(runner);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload.completed).toBe(true);
    expect(sent[1]?.payload.beamId).toBe(sent[0]?.payload.beamId);
  });

  it("skips ticks when a configured token cannot be resolved", async () => {
    const runner = testRunner(
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

it("stops the mirror service before listing settles without starting reads or uploads", async () => {
  vi.useFakeTimers();
  const context = {
    config: {},
    stateDir: "/unused",
    logger: beamTestLogger,
    scheduler: createTestPluginServiceScheduler(),
  };
  const list = pausedCall();
  const read = vi.fn();
  const catalog = createBeamTestCatalog({
    sessions: [{ threadId: "t1", recencyAt: Date.now() }],
    onList: list.call,
    onRead: read,
  });
  vi.spyOn(sessionCatalogRuntime, "listActiveSessionCatalogs").mockReturnValue([catalog]);
  const upload = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
    response: new Response("{}", { status: 200 }),
    finalUrl: "https://team.example/api/v1/beam/sessions",
    release: vi.fn(async () => undefined),
  });
  const service = createBeamMirrorService({
    runtime: createBeamTestRuntime(beamTestMirrorConfig()),
  });
  stops.push(() => context.scheduler.stop());

  await service.start(context);
  await vi.advanceTimersByTimeAsync(0);
  await list.started;
  await context.scheduler.stop();
  expect(read).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  list.release();
  await list.call.mock.results[0]?.value;
  expect(read).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
