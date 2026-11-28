import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
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
import * as cleaner from "./cleaner.js";
import { beamMirrorId } from "./mirror-candidate.js";
import { parseBeamMirrorConfig } from "./mirror-config.js";
import { registerBeamMirror } from "./mirror-service.js";
import { BEAM_MAX_ITEMS, parseBeamUpload } from "./types.js";

let fixture: ReturnType<typeof beamMirrorTestFixture>;
beforeEach(() => {
  fixture = beamMirrorTestFixture();
});

afterEach(() => vi.useRealTimers());

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

  it("binds both v2 base path spellings to the same receiver", () => {
    const endpoint = "https://team.example/deployment/api/v2/beam";
    const base = parseBeamMirrorConfig(beamTestMirrorConfig({ endpoint }));
    expect(base).toMatchObject({ endpoint, apiV2: true });
    expect(parseBeamMirrorConfig(beamTestMirrorConfig({ endpoint: endpoint + "/" }))).toEqual(base);
  });

  it.each([
    { bogus: true },
    { endpoint: "ftp://x" },
    { endpoint: "not a url" },
    { endpoint: "https://user@team.example/api/v2/beam" },
    { endpoint: "https://team.example/api/v2/beam/?filter=one" },
    { endpoint: "https://team.example/api/v2/beam#other" },
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
    "uploads once when response cancellation rejects: %s",
    async (rejectCancel) => {
      const { sent, warnings } = fixture;
      const cancel = vi.fn(async () => {
        if (rejectCancel) {
          throw new Error("cancel failed");
        }
      });
      const chronological = Array.from({ length: 3 }, (_, index) => ({
        type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
        text: `Message ${index}`,
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
      expect(sent[0]?.payload.items).toEqual(chronological);
      expect(warnings).toEqual([]);
    },
  );

  it.runIf(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT)(
    "publishes the latest chronological suffix within the real native cleaner byte limit",
    async () => {
      const { createBeamExecutableResolver } = await import("./executable.js");
      const chronological = Array.from({ length: 300 }, (_, index) => ({
        type: index % 2 === 0 ? ("userMessage" as const) : ("agentMessage" as const),
        text: `Message ${index}: ${"🙂 text ".repeat(200)}end`,
      }));
      const catalog = createBeamTestCatalog({ sessions: beamTestSessions(["native-300"]) });
      const newest = chronological.toReversed();
      const read = vi.fn<typeof catalog.read>(async ({ hostId, threadId, limit, cursor }) => {
        const start = Number(cursor ?? 0);
        return {
          hostId,
          threadId,
          items: newest.slice(start, start + limit),
          nextCursor: start + limit < newest.length ? String(start + limit) : undefined,
        };
      });
      const resolveExecutable = vi.fn(
        createBeamExecutableResolver(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT!),
      );
      const runner = fixture.runner(
        {},
        {
          listCatalogs: () => [{ ...catalog, read }],
          resolveExecutable,
        },
      );
      await runTicks(runner, 3);
      expect(read).toHaveBeenCalledTimes(12);
      expect(resolveExecutable).toHaveBeenCalledTimes(1);
      expect(fixture.sent).toHaveLength(1);
      const payload = fixture.sent[0]!.payload;
      expect(parseBeamUpload(structuredClone(payload)).ok).toBe(true);
      expect(payload.truncated).toBe(true);
      expect(payload.items.length).toBeGreaterThan(1);
      expect(payload.items.length).toBeLessThan(BEAM_MAX_ITEMS);
      expect(payload.items).toEqual(chronological.slice(-payload.items.length));
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(56 * 1024);
    },
  );

  it("checks newly granted multiplayer history on every poll and skips identical cleaner input", async () => {
    let grant = 0;
    let speaker = "one";
    let message = "unchanged";
    const catalog = createBeamTestCatalog();
    const read = vi.fn<typeof catalog.read>(async ({ hostId, threadId }) => ({
      hostId,
      threadId,
      items: [
        { type: "userMessage", text: message, speakerId: `${grant}:${speaker}` },
        { type: "userMessage", text: "first", speakerId: `${grant}:one` },
      ],
    }));
    const runner = fixture.runner(
      {},
      {
        listCatalogs: () => {
          grant++;
          return [{ ...catalog, read }];
        },
      },
    );
    await runTicks(runner, 3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(1);
    speaker = "two";
    await runner.tick();
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
    message = "same-second edit";
    await runner.tick();
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(3);
    expect(fixture.sent.at(-1)?.payload.items.at(-1)?.text).toBe("same-second edit");
  });

  it("remembers an equivalent v1 input without a second upload", async () => {
    let recencyAt = beamTestNow;
    const runner = fixture.runner({ sessions: () => beamTestSessions(["t1"], recencyAt) });
    await runner.tick();
    recencyAt++;
    await runTicks(runner, 3);
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
    expect(fixture.sent).toHaveLength(1);
  });

  it("requires a successful upload before skipping a clean and keeps authority changes cold", async () => {
    let token = "first-token";
    const runner = fixture.runner(
      {},
      {
        runtime: { config: { current: () => beamTestMirrorConfig({ token }) } },
      },
      { status: () => (fixture.sent.length === 1 ? 503 : 200) },
    );
    await runTicks(runner, 3);
    expect(fixture.sent).toHaveLength(2);
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
    token = "replacement-token";
    await runner.tick();
    expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(3);
  });

  it("pauses poll grants while an operator enrollment is resolving its native source", async () => {
    const gate = beamTestBarrier();
    const catalog = createBeamTestCatalog({ onList: gate.run, sessions: [] });
    const listCatalogs = vi.fn(() => [catalog]);
    const runner = createBeamTestRunner({
      endpoint: "https://team.example/api/v2/beam",
      listCatalogs,
      getPublicationStore: () => {
        throw new Error("missing source reached storage");
      },
    });
    const source = {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "selected",
      agentId: "main",
      sourceHomeId: "home",
    };
    const authority = { assertCurrent() {}, async revalidate() {} };
    const enrolled = runner.enroll(source, authority);
    await gate.started;
    await runner.tick();
    await expect(runner.enroll(source, authority)).rejects.toThrow("in progress");
    expect(listCatalogs).toHaveBeenCalledOnce();
    gate.release();
    await expect(enrolled).rejects.toThrow("Select a listed native source");
    await runner.tick();
    expect(listCatalogs).toHaveBeenCalledTimes(2);
  });

  it("uses the cleaner result for every v1 text field and sends nothing on cleaner failure", async () => {
    const session = { threadId: "one", recencyAt: beamTestNow, name: "unfiltered title" };
    const catalog = {
      sessions: [session],
      items: [{ type: "userMessage" as const, text: "unfiltered text" }],
    };
    const runner = fixture.runner(catalog);
    vi.spyOn(cleaner, "cleanBeamCandidate").mockImplementation(async (input) => {
      const candidate = JSON.parse(input) as cleaner.BeamCleanCandidate;
      expect(candidate).toMatchObject({ title: session.name, items: catalog.items });
      const packet = {
        version: 2 as const,
        beamId: "a".repeat(32),
        source: candidate.source,
        title: "clean title",
        updatedAt: candidate.updatedAt,
        completed: candidate.completed,
        items: [{ type: "userMessage" as const, text: "clean message", speaker: "p1" }],
      };
      return { packet, raw: Buffer.from(JSON.stringify(packet)) };
    });
    await runner.tick();
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.payload).toMatchObject({
      version: 1,
      beamId: beamMirrorId("claude", "gateway:local", "one"),
      title: "clean title",
    });
    expect(fixture.sent[0]?.payload.items).toEqual([
      { type: "userMessage", text: "clean message" },
    ]);
    const failing = fixture.runner(catalog);
    vi.spyOn(cleaner, "cleanBeamCandidate").mockRejectedValue(new Error("cleaner unavailable"));
    await failing.tick();
    expect(fixture.sent).toHaveLength(1);
  });

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

  it("fences two homes that share an existing publication ID before either is read", async () => {
    const read = vi.fn();
    const runner = fixture.runner({
      sessions: ["home-a", "home-b"].map((sourceHomeId) => ({
        threadId: "shared",
        sourceHomeId,
        recencyAt: beamTestNow,
      })),
      onRead: read,
    });
    await runner.tick();
    expect(read).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([]);
  });

  it("addresses the original released v1 publication with the full source locator", async () => {
    const read = vi.fn();
    const prior = beamMirrorId("claude", "gateway:local", "shared");
    const service = createBeamTestCatalog({
      sessions: [{ threadId: "shared", sourceHomeId: "stable-home", recencyAt: beamTestNow }],
      onRead: read,
    });
    const ids: string[] = [];
    await withMirrorServer(
      (_req, res, body) => {
        const id = (JSON.parse(body) as { beamId: string }).beamId;
        ids.push(id);
        if (id === prior) {
          res.writeHead(409);
          res.end(
            JSON.stringify({ beamId: id, handoff: { id: "1".repeat(32), owner: "gateway" } }),
          );
        } else {
          res.end();
        }
      },
      async (origin) => {
        const runner = createBeamTestRunner({ endpoint: origin, listCatalogs: () => [service] });
        await runTicks(runner);
      },
    );
    expect(ids).toEqual([prior]);
    expect(read.mock.calls).toEqual([["shared", "stable-home", "main"]]);
  });

  it("does not create a fresh v1 ID when a released primary Codex home becomes secondary", async () => {
    const prior = beamMirrorId("codex", "gateway:local", "shared");
    const secondary = "gateway:local:old-home";
    expect(beamMirrorId("codex", secondary, "shared")).not.toBe(prior);
    const read = vi.fn();
    const source = createBeamTestCatalog({
      id: "codex",
      hostId: secondary,
      onRead: read,
      sessions: [
        {
          threadId: "shared",
          sourceHomeId: "old-home",
          recencyAt: beamTestNow,
          exportPolicy: { origin: "native-local", automatic: true },
        },
      ],
    });
    const runner = createBeamTestRunner({
      runtime: createBeamTestRuntime(beamTestMirrorConfig({ catalogs: ["codex"] })),
      listCatalogs: () => [source],
    });
    await runner.tick();
    expect(read).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([]);
  });

  it("requires explicit selection for a qualified source without a stable old identity", async () => {
    const read = vi.fn();
    const runner = fixture.runner({
      onRead: read,
      sessions: [
        {
          threadId: "shared",
          sourceHomeId: "new-home",
          recencyAt: beamTestNow,
          exportPolicy: { origin: "native-local", automatic: true },
        },
      ],
    });
    await runner.tick();
    expect(read).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([]);
  });

  it("does not upload a pending read after catalog consent changes", async () => {
    const config = beamTestMirrorConfig();
    const pause = beamTestBarrier();
    const runner = fixture.runner(
      { onRead: pause.run },
      { runtime: createBeamTestRuntime(config) },
    );
    const tick = runner.tick();
    await pause.started;
    config.plugins.entries.beam.config.mirror.catalogs = ["codex"];
    pause.release();
    await tick;
    expect(fixture.sent).toEqual([]);
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

describe("registerBeamMirror", () => {
  it.each(["list", "read"] as const)(
    "stops before a paused %s settles without resuming work",
    async (stage) => {
      vi.useFakeTimers();
      const context = beamTestServiceContext(),
        pause = beamTestBarrier();
      const list = stage === "list" ? pause.run : vi.fn();
      const read = stage === "read" ? pause.run : vi.fn();
      context.catalogExports = {
        listCatalogs: () => [
          createBeamTestCatalog({
            sessions: beamTestSessions(["t1", "t2"], Date.now()),
            onList: list,
            onRead: read,
          }),
        ],
      };
      const upload = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockRejectedValue(new Error("unexpected upload after stop"));
      const api = createTestPluginApi({
        runtime: createBeamTestRuntime(beamTestMirrorConfig()),
      });
      const registerService = vi.spyOn(api, "registerService");
      registerBeamMirror(api, async () => {
        throw new Error("unexpected test process");
      });
      const service = registerService.mock.calls[0]?.[0];
      assert(service?.apiVersion === 2);
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
