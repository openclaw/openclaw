import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { projectCodexCatalogNativeThread } from "../session-catalog-native-projection.js";
import { useClientHarnesses } from "./client-harness.test-support.js";
import * as messageDecoder from "./client-message-decoder.js";
import type { JsonObject } from "./protocol.js";

const makeHarness = useClientHarnesses();

function createHarness() {
  const harness = makeHarness();
  return Object.assign(harness, {
    list: (
      params: JsonObject = {},
      options: NonNullable<Parameters<typeof harness.client.request>[2]> = {},
    ) => harness.client.request("thread/list", params, { catalogPreview: true, ...options }),
    reply: (result: JsonObject, index = 0) =>
      harness.send({ id: requestId(harness, index), result }),
  });
}

function requestId(harness: ReturnType<typeof makeHarness>, index = 0): string | number {
  return (JSON.parse(harness.writes[index]!) as { id: string | number }).id;
}

async function startWorker(harness: ReturnType<typeof createHarness>) {
  const request = harness.list();
  harness.reply({ data: [], unused: "x".repeat(64 * 1024) });
  await request;
  const pool = submitted.mock.contexts[0];
  submitted.mockClear();
  assert(pool instanceof WorkerTaskPool);
  return pool;
}

let parse: MockInstance<typeof messageDecoder.parseCodexAppServerMessage>;
let submitted: MockInstance<typeof WorkerTaskPool.prototype.run>;
beforeEach(() => {
  parse = vi.spyOn(messageDecoder, "parseCodexAppServerMessage");
  submitted = vi.spyOn(WorkerTaskPool.prototype, "run");
});

describe("Codex catalog worker transport", () => {
  it.each(["page", "close"])("joins idle retirement before %s completes", async (nextAction) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const pool = await startWorker(harness);
    const retired = createDeferred<void>();
    const release = createDeferred<void>();
    const rotate = pool.rotate.bind(pool);
    const rotation = vi.spyOn(pool, "rotate").mockImplementation(async () => {
      await rotate();
      retired.resolve();
      await release.promise;
    });
    vi.advanceTimersByTime(60_000);
    expect(rotation).toHaveBeenCalledOnce();
    await retired.promise;
    expect(pool.getSnapshot().workers).toBe(0);
    expect(harness.stdinDestroyed).toBe(false);
    expect(harness.client.getCloseError()).toBeUndefined();
    const pageSubmitted = vi.spyOn(pool, "run");
    const page = harness.list();
    const outcome = nextAction === "close" ? expect(page).rejects.toThrow(/closed/u) : page;
    harness.reply({ data: [{ id: "queued" }], unused: "x".repeat(64 * 1024) }, 1);
    let closed = false;
    const closing =
      nextAction === "close"
        ? harness.client.closeAndWait().then(() => {
            closed = true;
          })
        : undefined;
    if (closing) {
      harness.emitExit();
    }
    try {
      await Promise.resolve();
      expect(pageSubmitted).not.toHaveBeenCalled();
      expect(closed).toBe(false);
    } finally {
      release.resolve();
    }
    if (closing) {
      await closing;
      await outcome;
      expect(pageSubmitted).not.toHaveBeenCalled();
    } else {
      await expect(page).resolves.toEqual({ data: [{ id: "queued", projectId: null }] });
      expect(pageSubmitted).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().workers).toBe(1);
    }
  });

  it("retries failed idle retirement before terminal close releases worker custody", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const pool = await startWorker(harness);
    const entered = createDeferred<void>();
    const failedStop = createDeferred<number>();
    const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(() => {
      entered.resolve();
      return failedStop.promise;
    });
    vi.advanceTimersByTime(60_000);
    await entered.promise;
    const closing = harness.client.closeAndWait();
    harness.emitExit();
    failedStop.reject(new Error("synthetic worker stop failed"));
    try {
      await expect(closing).resolves.toMatchObject({ exited: true });
    } finally {
      await pool.close();
    }
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(pool.getSnapshot().workers).toBe(0);
  });

  it.each([
    { name: "UTF-8 at the bound", bytes: 64 * 1024, character: "猫", worker: false },
    { name: "UTF-8 above the bound", bytes: 64 * 1024 + 1, character: "猫", worker: true },
  ])("projects $name with byte-bounded inline decoding", async ({ bytes, character, worker }) => {
    const harness = createHarness();
    const request = harness.list({ limit: 64 }, { catalogRows: 1 });
    const response = {
      result: {
        data: [
          { id: "selected", preview: "\u001b[32m猫\u001b[0m", unused: "discarded" },
          { id: "discarded", path: "/".repeat(4_097) },
        ],
        nextCursor: "next",
        backwardsCursor: null,
        unused: "",
      },
      id: requestId(harness),
    };
    const paddingBytes = bytes - Buffer.byteLength(JSON.stringify(response));
    const characterBytes = Buffer.byteLength(character);
    response.result.unused =
      character.repeat(Math.floor(paddingBytes / characterBytes)) +
      "x".repeat(paddingBytes % characterBytes);
    const line = JSON.stringify(response);
    expect(Buffer.byteLength(line)).toBe(bytes);
    harness.process.stdout.write(`${line}\n`);
    await expect(request).resolves.toEqual({
      data: [{ id: "selected", projectId: null, preview: "猫" }],
      nextCursor: "next",
      backwardsCursor: null,
    });
    expect(submitted).toHaveBeenCalledTimes(worker ? 1 : 0);
  });

  it.each([1, 100_000])(
    "projects metadata without trimming history (%i repeats)",
    async (repeats) => {
      const harness = createHarness();
      const thread = {
        id: "native-thread",
        projectId: "project-1",
        sessionId: "session-1",
        historyMode: "paginated",
        name: "  Catalog worker  ",
        cwd: "/workspace/trailing space ",
        path: "/synthetic/sessions/native-thread.jsonl",
        modelProvider: "openai",
        originator: "native-cli",
        cliVersion: "0.154.0",
        createdAt: 10,
        updatedAt: 20,
        recencyAt: 21,
        source: "cli",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        preview: '\u001b[32mReview "catalog-list:99" and 猫\u001b[0m '.repeat(
          Math.min(repeats, 2_000),
        ),
        gitInfo: { branch: "feature/catalog", sha: "unused-sha", originUrl: "unused-origin" },
        extra: { text: "unused ".repeat(repeats) },
        turns: [{ id: "turn-1", items: [{ id: "item-1", type: "agentMessage", text: "history" }] }],
      };
      const read = harness.client.request(
        "thread/read",
        { threadId: thread.id, includeTurns: false },
        { catalogPreview: true },
      );
      harness.send({ id: requestId(harness), result: { thread } });
      await expect(read).resolves.toEqual({
        thread: {
          ...projectCodexCatalogNativeThread(thread, sanitizeTerminalText),
          cwd: thread.cwd,
          historyMode: "paginated",
        },
      });
      expect(parse).not.toHaveBeenCalled();

      const history = harness.client.request(
        "thread/read",
        { threadId: thread.id, includeTurns: true },
        { catalogPreview: true },
      );
      harness.send({ id: requestId(harness, 1), result: { thread } });
      await expect(history).resolves.toEqual({ thread });
      expect(parse).toHaveBeenCalledOnce();
      expect(submitted).toHaveBeenCalledTimes(repeats === 1 ? 0 : 1);
    },
  );

  it("preserves stdout order across projected responses, notifications, and server requests", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    const completed = createDeferred<void>();
    harness.client.addNotificationHandler(({ method }) => {
      observed.push(method);
      if (method === "turn/completed") {
        completed.resolve();
      }
    });
    harness.client.addRequestHandler(({ method }) => {
      observed.push(method);
      return { decision: "decline" };
    });
    const requests = ["first", "second"].map((name) =>
      harness.list(
        { limit: 1 },
        {
          attemptWaiterFinished: () => observed.push(`${name} response`),
        },
      ),
    );
    const frames = [
      { method: "turn/started", params: { threadId: "thread-1" } },
      {
        result: { data: [{ id: "second" }], unused: "x".repeat(64 * 1024), nextCursor: "next" },
        id: requestId(harness, 1),
      },
      {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1" },
      },
      { method: "item/agentMessage/delta", params: { delta: "hello" } },
      { id: requestId(harness), result: { data: [{ id: "first" }] } },
      { method: "turn/completed", params: { threadId: "thread-1" } },
    ];
    harness.process.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    await completed.promise;
    expect(observed).toEqual([
      "turn/started",
      "second response",
      "item/commandExecution/requestApproval",
      "item/agentMessage/delta",
      "first response",
      "turn/completed",
    ]);
    await expect(Promise.all(requests)).resolves.toEqual([
      { data: [{ id: "first", projectId: null }] },
      { data: [{ id: "second", projectId: null }], nextCursor: "next" },
    ]);
    expect(JSON.parse(await harness.waitForWrite(2))).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it.each([1, 100_000])(
    "discards cancelled pages without disturbing the next (%i repeats)",
    async (repeats) => {
      const harness = createHarness();
      const abort = new AbortController();
      const cancelled = harness.list({ limit: 64 }, { signal: abort.signal });
      const rejection = expect(cancelled).rejects.toThrow(/aborted/u);
      abort.abort();
      await rejection;
      const next = harness.list({ limit: 1 });
      harness.reply({ data: [{ id: "late", preview: "discarded ".repeat(repeats) }] });
      harness.reply({ data: [{ id: "current" }] }, 1);
      await expect(next).resolves.toEqual({ data: [{ id: "current", projectId: null }] });
      expect(parse).not.toHaveBeenCalled();
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("preserves native RPC rejection and keeps projection failures scoped to their request", async () => {
    const harness = createHarness();
    const native = harness.list();
    const nativeRejected = expect(native).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32600,
      message: "synthetic invalid cursor",
    });
    harness.send({
      id: requestId(harness),
      error: { code: -32600, message: "synthetic invalid cursor" },
    });
    await nativeRejected;
    const invalid = harness.list();
    const invalidRejected = expect(invalid).rejects.toThrow("invalid thread id");
    harness.reply({ data: [{ preview: "missing id" }] }, 1);
    await invalidRejected;
    const next = harness.list();
    harness.reply({ data: [] }, 2);
    await expect(next).resolves.toEqual({ data: [] });
    expect(harness.client.getCloseError()).toBeUndefined();
  });

  it("logs only malformed worker frame sizes and accepts the next catalog frame", async () => {
    const harness = createHarness();
    const token = `synthetic-secret-${"padding".repeat(500)}`;
    const contentMarker = "synthetic-private-worker-tool-result-猫";
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = harness.list();
    const malformed = `{"id":${JSON.stringify(requestId(harness))},"result":{"token":${JSON.stringify(token)},"data":[{"id":"thread","preview":"${contentMarker} invalid \\q`;
    harness.process.stdout.write(`${malformed}\n`);
    harness.reply({ data: [] });
    await expect(request).resolves.toEqual({ data: [] });
    expect(warn).toHaveBeenCalledExactlyOnceWith("failed to parse codex app-server message", {
      byteCount: Buffer.byteLength(malformed),
      charCount: malformed.length,
      fragmentCount: 1,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(contentMarker);
    expect(parse).not.toHaveBeenCalled();
  });
  it("rejects oversized catalog frames before decoding and accepts the next response", async () => {
    const harness = createHarness();
    const request = harness.list();
    const rejected = expect(request).rejects.toThrow("exceeds 8 MiB");
    harness.reply({ data: [{ id: "huge", preview: "x".repeat(8 * 1024 * 1024) }] });
    await rejected;
    expect(submitted).not.toHaveBeenCalled();
    const next = harness.list();
    harness.reply({ data: [{ id: "healthy" }] }, 1);
    await expect(next).resolves.toEqual({ data: [{ id: "healthy", projectId: null }] });
    expect(harness.client.getCloseError()).toBeUndefined();
  });

  it("keeps an oversized singleton's continuation without retaining rows at capacity", async () => {
    const harness = createHarness();
    const request = harness.list({ limit: 1 }, { catalogRows: 0 });
    harness.reply({
      data: [{ id: "huge", preview: "x".repeat(8 * 1024 * 1024) }],
      nextCursor: "opaque-continuation",
    });
    await expect(request).resolves.toEqual({ data: [], nextCursor: "opaque-continuation" });
  });

  it.each([64 * 1024 * 1024, 64 * 1024 * 1024 + 1])(
    "bounds singleton parsing at 64 MiB (%i bytes)",
    async (bytes) => {
      const harness = createHarness();
      const request = harness.list({ limit: 1 });
      const expected = {
        data: [{ id: "bounded", projectId: null, catalogError: "oversized-thread" }],
        nextCursor: null,
      };
      const outcome =
        bytes > 64 * 1024 * 1024
          ? expect(request).rejects.toThrow("exceeds 8 MiB")
          : expect(request).resolves.toEqual(expected);
      const raw = JSON.stringify({
        id: requestId(harness),
        result: { data: [{ id: "bounded" }], nextCursor: null },
      });
      harness.process.stdout.write(`${raw}${" ".repeat(bytes - Buffer.byteLength(raw))}\n`);
      await outcome;
      expect(submitted).toHaveBeenCalledTimes(bytes > 64 * 1024 * 1024 ? 0 : 1);
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it.each(["identity", "cursor", "missing cursor", "cardinality", "JSON"])(
    "rejects oversized singleton recovery with invalid %s",
    async (invalid) => {
      const harness = createHarness();
      const request = harness.list({ limit: 1 });
      const rejected = expect(request).rejects.toThrow("exceeds 8 MiB");
      const response = {
        id: requestId(harness),
        result: {
          data: [
            { id: invalid === "identity" ? "" : "huge", preview: "x".repeat(8 * 1024 * 1024) },
            ...(invalid === "cardinality" ? [{ id: "extra" }] : []),
          ],
          nextCursor:
            invalid === "missing cursor"
              ? undefined
              : invalid === "cursor"
                ? 42
                : "opaque-continuation",
        },
      };
      const raw = JSON.stringify(response);
      harness.process.stdout.write(
        `${invalid === "JSON" ? raw.replace('"nextCursor":', '"unused":[1,],"nextCursor":') : raw}\n`,
      );
      await rejected;
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("preserves meaningful text after a long ANSI prefix through the worker", async () => {
    const harness = createHarness();
    const request = harness.list();
    harness.reply({
      data: [{ id: "ansi", preview: "\u001b[0m".repeat(15_000) + "meaningful text" }],
    });
    await expect(request).resolves.toEqual({
      data: [{ id: "ansi", projectId: null, preview: "meaningful text" }],
    });
  });
});

describe("catalog previews", () => {
  beforeEach(() => vi.useFakeTimers());
  const prefix = "x".repeat(499);
  const tail = "y".repeat(4096);
  const fittingPair = "x".repeat(498) + "😀";
  const oscPayload = "p".repeat(3000);

  it.each([0, 1])(
    "projects only the remaining %i catalog rows without shrinking the native page",
    async (catalogRows) => {
      const harness = createHarness();
      const selected = {
        id: "selected",
        projectId: null,
        preview: "Kept first user request",
        cwd: "/workspace/selected",
      };
      const cache = vi.fn((thread: { id: string }) => {
        if (catalogRows === 0 || thread.id !== "selected") {
          throw new Error("Discarded rows must not read the resident preview cache");
        }
        return undefined;
      });
      const request = harness.list(
        { limit: 64, cursor: "native-start", useStateDbOnly: true },
        { timeoutMs: 1_000, catalogPreviewCache: cache, catalogRows },
      );
      const frame = JSON.parse(harness.writes[0]!);
      expect(frame).toMatchObject({
        method: "thread/list",
        params: { limit: 64, cursor: "native-start", useStateDbOnly: true },
      });
      expect(frame.params).not.toHaveProperty("catalogRows");
      harness.reply({
        data: Array.from({ length: 64 }, (_, index) =>
          index === 0
            ? { ...selected, preview: `\u001b[32m${selected.preview}\u001b[0m` }
            : {
                id: `discarded-${index}`,
                preview: "Discarded preview ".repeat(1024),
                path: "/".repeat(4097),
                turns: [{ items: [{ text: "Discarded transcript ".repeat(1024) }] }],
              },
        ),
        nextCursor: "opaque-native-next",
        backwardsCursor: "opaque-native-previous",
      });
      await expect(request).resolves.toEqual({
        data: catalogRows ? [selected] : [],
        nextCursor: "opaque-native-next",
        backwardsCursor: "opaque-native-previous",
      });
      expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(
        catalogRows ? ["selected"] : [],
      );
      expect(harness.writes).toHaveLength(1);
    },
  );

  it("bounds catalog payloads while preserving ordinary thread/list results", async () => {
    const harness = createHarness();
    // Stay below the 8 MiB frame cap while exercising worker-side projection.
    const large = "unused native history ".repeat(80_000);
    const thread = {
      id: "bounded-metadata",
      preview: "x".repeat(1024 * 1024),
      cwd: "/workspace/project",
      name: "Sidebar review",
      gitInfo: { branch: "catalog-fix", sha: large, originUrl: large },
      extra: { payload: large },
      turns: [{ items: [{ text: large }] }],
    };
    const catalog = harness.list({ limit: 64, useStateDbOnly: true }, { timeoutMs: 1_000 });
    expect(Buffer.byteLength(JSON.stringify(thread))).toBeLessThan(8 * 1024 * 1024);
    harness.reply({ data: [thread] });
    const page = await catalog;
    expect(page.data[0]).toMatchObject({
      id: thread.id,
      preview: "x".repeat(500),
      cwd: thread.cwd,
      name: thread.name,
      gitInfo: { branch: "catalog-fix" },
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_048);
    expect(parse).not.toHaveBeenCalled();
    const ordinaryThread = { ...thread, preview: thread.preview.repeat(2) };
    expect(Buffer.byteLength(JSON.stringify(ordinaryThread))).toBeGreaterThan(8 * 1024 * 1024);
    const ordinary = harness.client.request("thread/list", { limit: 64, useStateDbOnly: true });
    harness.reply({ data: [ordinaryThread] }, 1);
    await expect(ordinary).resolves.toEqual({ data: [ordinaryThread] });
    expect(parse).toHaveBeenCalledOnce();
  });

  it.each([0, 64 * 1024])(
    "preserves native preview cache states with %i bytes of padding",
    async (padding) => {
      const harness = createHarness();
      const cases = [
        { id: "cleared", preview: "", cached: "retained", expected: "" },
        { id: "whitespace", preview: " \n\t ", cached: "retained", expected: "retained" },
        { id: "controls", preview: "\u001b[0m", cached: "retained", expected: "retained" },
        { id: "newly-visible", preview: "visible", cached: "", expected: "visible" },
        { id: "missing", cached: "retained", expected: "retained" },
        { id: "missing-empty", cached: "", expected: "" },
        { id: "empty", preview: "", cached: "", expected: "" },
        { id: "cache-miss", preview: "uncached", cached: undefined, expected: "uncached" },
      ];
      const previews = new Map(cases.map(({ id, cached }) => [id, cached]));
      const cache = vi.fn(({ id }: { id: string }) => previews.get(id));
      const request = harness.list({}, { catalogPreviewCache: cache });
      harness.reply({
        data: cases.map(({ id, preview }) => ({ id, preview })),
        unused: "x".repeat(padding),
      });
      await expect(request).resolves.toEqual({
        data: cases.map(({ id, expected }) => ({ id, projectId: null, preview: expected })),
      });
      expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(cases.map(({ id }) => id));
    },
  );

  it.each([
    ["leading whitespace beyond the input prefix", " \t\n".repeat(4096) + "visible", "visible"],
    ["whitespace before ANSI removal", "a \u001b[0m b", "a  b"],
    ["space at the output boundary", prefix + " " + tail, prefix + " "],
    ["trailing whitespace beyond the input prefix", prefix + " \n\t".repeat(4096), prefix],
    ["surrogate pair across the output boundary", prefix + "😀" + tail, prefix],
    ["surrogate pair fitting the output boundary", fittingPair + tail, fittingPair],
    ["surrogate lookahead after trim", " ".repeat(1548) + prefix + "😀tail", prefix],
    ["lone surrogate at the output boundary", prefix + "\ud800" + tail, prefix + "\ufffd"],
    ["C0 removal after trim", "a\u0000b \u007f c".repeat(400), "ab  c".repeat(100)],
    ["OSC terminator beyond input prefix", "\u001b]0;" + oscPayload + "\u0007visible", "visible"],
    ["unterminated OSC payload", "\u001b]0;" + oscPayload, "]0;" + "p".repeat(497)],
    ["C1 CSI crossing the input prefix", "\u009b" + "1;".repeat(1500) + "31mvisible", "visible"],
  ])("preserves %s in catalog previews", async (_name, preview, expected) => {
    const harness = createHarness();
    const request = harness.list({ limit: 1 }, { timeoutMs: 1_000 });
    harness.reply({ data: [{ id: "preview", projectId: null, preview }] });
    await expect(request).resolves.toEqual({
      data: [{ id: "preview", projectId: null, preview: expected }],
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
