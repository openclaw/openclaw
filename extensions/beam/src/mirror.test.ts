import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import * as sessionCatalogRuntime from "openclaw/plugin-sdk/session-catalog-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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
import { beamMirrorId, createBeamMirrorService, parseBeamMirrorConfig } from "./mirror.js";
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

async function withMirrorServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (origin: string) => Promise<void>,
) {
  await withServer((req, res) => {
    void consumeBuffer(req).then(
      (body) => respond(req, res, body.toString("utf8")),
      (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  }, run);
}

async function withMirrorRunner(
  respond: Parameters<typeof withMirrorServer>[0],
  run: (runner: ReturnType<typeof createBeamTestRunner>) => Promise<void>,
) {
  await withMirrorServer(respond, (origin) =>
    run(createBeamTestRunner({ endpoint: `${origin}/beam`, logger: fixture.logger })),
  );
}

async function runTicks(runner: { tick: () => Promise<unknown> }, count = 2) {
  for (let i = 0; i < count; i++) {
    await runner.tick();
  }
}

describe("parseBeamMirrorConfig", () => {
  it("returns undefined without mirror config", () => {
    expect(parseBeamMirrorConfig({})).toBeUndefined();
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

describe("createBeamMirrorRunner", () => {
  it.each([
    { target: "private origin", status: 307, transient: false },
    { target: "same origin", status: 301, transient: false },
    { target: "same origin", status: 307, transient: true },
  ])(
    "blocks and redacts $status redirects to $target after transient=$transient",
    async ({ target, status, transient }) => {
      const { warnings } = fixture;
      const bodies: string[] = [],
        leaked: string[] = [];
      await withMirrorServer(
        (_req, res, body) => {
          leaked.push(body);
          res.end();
        },
        async (privateOrigin) => {
          await withMirrorRunner(
            (req, res, body) => {
              if (req.url !== "/beam") {
                leaked.push(body);
                res.end();
                return;
              }
              bodies.push(body);
              if (transient && bodies.length === 1) {
                res.statusCode = 503;
              } else {
                const origin = target === "private origin" ? privateOrigin : "";
                res.writeHead(status, { Location: `${origin}/redirected?private=do-not-log` });
              }
              res.end();
            },
            async (runner) => {
              await runTicks(runner, 3);
              expect(bodies).toHaveLength(transient ? 2 : 1);
              expect(bodies[0]).toContain("Fix the flow.");
              expect(leaked).toEqual([]);
              expect(warnings).toHaveLength(transient ? 2 : 1);
              if (transient) {
                expect(warnings[0]).toContain("upload failed (503)");
              }
              expect(warnings.at(-1)).toContain(
                `upload blocked for claude: receiver returned redirect (${status})`,
              );
              expect(warnings.join(" ")).not.toContain("do-not-log");
            },
          );
        },
      );
    },
  );

  it("rechecks once after runner restart and resumes after the endpoint changes", async () => {
    const requests: string[] = [];
    await withMirrorServer(
      (req, res) => {
        requests.push(req.url ?? "");
        if (req.url === "/redirect") {
          res.writeHead(307, { Location: "/redirected" });
        }
        res.end();
      },
      async (origin) => {
        let endpoint = `${origin}/redirect`;
        const runtime = {
          config: { current: () => beamTestMirrorConfig({ endpoint }) },
        };
        let active = true;
        const catalog = createBeamTestCatalog({
          sessions: () => (active ? beamTestSessions(["t1"]) : []),
        });
        const createRunner = () =>
          createBeamTestRunner({
            runtime,
            listCatalogs: () => [catalog],
          });
        const runner = createRunner();
        await runTicks(runner);
        const restartedRunner = createRunner();
        await restartedRunner.tick();
        endpoint = `${origin}/direct`;
        await runTicks(restartedRunner);
        endpoint = `${origin}/other`;
        active = false;
        await restartedRunner.tick();
        expect(requests).toEqual(["/redirect", "/redirect", "/direct"]);
        active = true;
        await runTicks(restartedRunner);
        endpoint = `${origin}/direct`;
        await restartedRunner.tick();
        expect(requests).toEqual(["/redirect", "/redirect", "/direct", "/other", "/direct"]);
      },
    );
  });

  it.each([false, true])(
    "uploads the newest suffix once when cancellation rejects: %s",
    async (rejectCancel) => {
      const count = 300;
      const { sent, warnings } = fixture;
      const cancel = vi.fn(async () => {
        if (rejectCancel) {
          throw new Error("cancel failed");
        }
      });
      const chronological = Array.from({ length: count }, (_, index) => ({
        type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
        text: `Message ${index}: ${"🙂\n\u0000".repeat(200)}end`,
      }));
      const runner = fixture.runner(
        {
          sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: beamTestNow - 60_000 }],
          items: chronological.toReversed(),
        },
        { runtime: createBeamTestRuntime(beamTestMirrorConfig({ token: "scratch-token" })) },
        { cancel },
      );
      await runTicks(runner);
      expect(sent).toHaveLength(1);
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
      expect(payload.items.length).toBeLessThanOrEqual(BEAM_MAX_ITEMS);
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(56 * 1024);
      expect(warnings).toEqual([]);
    },
  );

  it("uploads chronological sanitized text, latest model and source truncation", async () => {
    const { sent } = fixture;
    const display = createTestPluginApi({ id: "incidents" }).inlineView(
      "incident",
      { incidentId: "INC-42" },
      { version: 3, summary: "Investigating." },
    );
    const runner = fixture.runner({
      sessions: [{ threadId: "t-model", recencyAt: beamTestNow, modelProvider: "openai" }],
      items: [
        { type: "agentMessage", text: "Latest", model: "gpt-5.6-sol" },
        { type: "agentMessage", text: "Earlier", model: "gpt-5.6-terra" },
        { type: "agentMessage", text: display.content[0].text, raw: display.details },
        { type: "reasoning", text: "private thoughts" },
        { type: "toolResult", raw: { output: "secret output" } },
        { type: "toolCall", text: "rm -rf /tmp/x", raw: { command: "secret" } },
        { type: "userMessage", text: "Continue this", truncated: true },
      ],
    });
    await runner.tick();
    expect(sent[0]?.payload).toMatchObject({
      sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
      truncated: true,
    });
    expect(sent[0]?.payload.items).toEqual([
      { type: "userMessage", text: "Continue this" },
      {
        type: "other",
        text: "1 tool calls, 1 tool results, 1 reasoning items; raw content dropped",
      },
      { type: "agentMessage", text: "Investigating." },
      { type: "agentMessage", text: "Earlier" },
      { type: "agentMessage", text: "Latest" },
    ]);
    expect(JSON.stringify(sent[0]?.payload)).not.toMatch(
      /pluginInlineView|secret|private thoughts/,
    );
    expect(parseBeamUpload(structuredClone(sent[0]?.payload)).ok).toBe(true);
  });

  it("forwards lifecycle abort and waits for guarded response cleanup without warning", async () => {
    vi.useFakeTimers();
    const requestStarted = createDeferred<void>();
    const cleanup = beamTestBarrier(),
      cancel = vi.fn();
    let signal: AbortSignal | undefined;
    const { warnings, logger } = fixture;
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (options) => {
      const abortSignal = options.signal;
      assert(abortSignal, "missing runner abort signal");
      signal = abortSignal;
      requestStarted.resolve();
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }),
        finalUrl: options.url,
        release: cleanup.run,
      };
    });
    const runner = createScheduledBeamTestRunner({ logger });
    try {
      const tick = runner.tick();
      await requestStarted.promise;
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
      await runner.stop();
    }
  });

  it("ignores idle sessions, node hosts, the beam catalog, and unlisted catalogs", async () => {
    const catalogs = [
      createBeamTestCatalog({ sessions: beamTestSessions(["old"], beamTestNow - 86_400_000) }),
      createBeamTestCatalog({ id: "codex", hostKind: "node" }),
      createBeamTestCatalog({ id: "beam" }),
      createBeamTestCatalog({ id: "pi" }),
    ];
    const runner = fixture.runner({}, { listCatalogs: () => catalogs });
    await runner.tick();
    expect(fixture.sent).toHaveLength(0);
  });

  it("warns once when profile isolation disables process-HOME fallback", async () => {
    const runner = fixture.runner({ sessions: [], processHomeFallbackAllowed: false });

    await runTicks(runner);

    expect(fixture.warnings).toEqual([
      "beam mirror process-HOME fallback disabled: isolated state; only explicit catalog roots can be mirrored",
    ]);
  });

  it("sends one completed upload for an observed idle session on a partial host page", async () => {
    const { sent } = fixture;
    let clock = beamTestNow;
    const runner = fixture.runner(
      {
        hostCursor: "older-sessions",
        sessions: beamTestSessions(["t1"], beamTestNow - 60_000),
      },
      { now: () => clock },
    );
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.completed).toBe(false);
    // Session goes idle past the window; the next tick finalizes it once.
    clock = beamTestNow + 4 * 60 * 60_000;
    await runTicks(runner);
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
      vi.spyOn(sessionCatalogRuntime, "listActiveSessionCatalogs").mockReturnValue([
        createBeamTestCatalog({
          sessions: beamTestSessions(["t1", "t2"], Date.now()),
          onList: list,
          onRead: read,
        }),
      ]);
      const upload = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockRejectedValue(new Error("unexpected upload after stop"));
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
        await context.scheduler.stop();
      }
    },
  );
});
