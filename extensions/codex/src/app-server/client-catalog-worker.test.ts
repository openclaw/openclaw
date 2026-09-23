import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectCodexCatalogNativeResponse,
  projectCodexCatalogNativeThread,
} from "../session-catalog-native-projection.js";
import { CodexAppServerMessageDecoder } from "./client-message-decoder.js";
import type { JsonObject } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const harnesses: ReturnType<typeof createClientHarness>[] = [];

function createHarness() {
  const harness = createClientHarness({ autoEmitExit: false });
  harnesses.push(harness);
  return harness;
}

function requestId(harness: ReturnType<typeof createClientHarness>, index = 0): string | number {
  return (JSON.parse(harness.writes[index]!) as { id: string | number }).id;
}

async function startWorker(harness: ReturnType<typeof createClientHarness>) {
  const submitted = vi.spyOn(WorkerTaskPool.prototype, "run");
  const request = harness.client.request("thread/list", {}, { catalogPreview: true });
  harness.send({ id: requestId(harness), result: { data: [], unused: "x".repeat(64 * 1024) } });
  await request;
  const pool = submitted.mock.contexts[0];
  submitted.mockRestore();
  assert(pool instanceof WorkerTaskPool);
  return pool;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.client.close();
    harness.emitExit();
    await harness.client.closeAndWait();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog worker transport", () => {
  it("retires a completed decoder while keeping the client ready for another page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const pool = await startWorker(harness);
    const retired = createDeferred<void>();
    const rotate = pool.rotate.bind(pool);
    const rotation = vi.spyOn(pool, "rotate").mockImplementation(async () => {
      await rotate();
      retired.resolve();
    });
    vi.advanceTimersByTime(60_000);
    expect(rotation).toHaveBeenCalledOnce();
    await retired.promise;
    expect(pool.getSnapshot().workers).toBe(0);
    expect(harness.stdinDestroyed).toBe(false);
    expect(harness.client.getCloseError()).toBeUndefined();

    const next = harness.client.request("thread/list", {}, { catalogPreview: true });
    harness.send({
      id: requestId(harness, 1),
      result: { data: [{ id: "after-idle" }], unused: "x".repeat(64 * 1024) },
    });
    await expect(next).resolves.toEqual({ data: [{ id: "after-idle", projectId: null }] });
    expect(pool.getSnapshot().workers).toBe(1);
  });

  it.each([false, true])(
    "keeps incomplete decoder state beyond idle retirement (cancelled: %s)",
    async (cancelled) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const harness = createHarness();
      const pool = await startWorker(harness);
      const rotation = vi.spyOn(pool, "rotate");
      const abort = new AbortController();
      const request = harness.client.request(
        "thread/list",
        {},
        { catalogPreview: true, signal: abort.signal },
      );
      const resumed = once(harness.process.stdout, "resume");
      harness.process.stdout.write(
        `{"id":${requestId(harness, 1)},"result":{"data":[{"id":"fragmented","preview":"first\n`,
      );
      await resumed;
      if (cancelled) {
        const rejected = expect(request).rejects.toThrow(/aborted/u);
        abort.abort();
        await rejected;
      }
      vi.advanceTimersByTime(120_000);
      expect(rotation).not.toHaveBeenCalled();
      harness.process.stdout.write('second"}]}}\n');
      if (!cancelled) {
        await expect(request).resolves.toEqual({
          data: [{ id: "fragmented", projectId: null, preview: "first second" }],
        });
      }
      const next = harness.client.request("thread/list", {}, { catalogPreview: true });
      harness.send({ id: requestId(harness, 2), result: { data: [{ id: "current" }] } });
      await expect(next).resolves.toEqual({ data: [{ id: "current", projectId: null }] });
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

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
    const submitted = vi.spyOn(pool, "run");
    const page = harness.client.request("thread/list", {}, { catalogPreview: true });
    const outcome = nextAction === "close" ? expect(page).rejects.toThrow(/closed/u) : page;
    harness.send({
      id: requestId(harness, 1),
      result: { data: [{ id: "queued" }], unused: "x".repeat(64 * 1024) },
    });
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
      expect(submitted).not.toHaveBeenCalled();
      expect(closed).toBe(false);
    } finally {
      release.resolve();
    }
    if (closing) {
      await closing;
      await outcome;
      expect(submitted).not.toHaveBeenCalled();
    } else {
      await expect(page).resolves.toEqual({ data: [{ id: "queued", projectId: null }] });
      expect(submitted).toHaveBeenCalledOnce();
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
    { name: "ASCII at the bound", bytes: 64 * 1024, character: "x", worker: false },
    { name: "UTF-8 at the bound", bytes: 64 * 1024, character: "猫", worker: false },
    { name: "UTF-8 above the bound", bytes: 64 * 1024 + 1, character: "猫", worker: true },
  ])("projects $name with byte-bounded inline decoding", async ({ bytes, character, worker }) => {
    const harness = createHarness();
    const submitted = vi.spyOn(WorkerTaskPool.prototype, "run");
    const request = harness.client.request(
      "thread/list",
      { limit: 64 },
      { catalogPreview: true, catalogRows: 1 },
    );
    const response = {
      result: {
        data: [
          { id: "selected", preview: "\u001b[32m猫\u001b[0m", unused: "discarded" },
          { id: "discarded", path: "/".repeat(4_097) },
        ],
        nextCursor: "next",
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
    });
    expect(submitted).toHaveBeenCalledTimes(worker ? 1 : 0);
  });

  it.each([1, 100_000])(
    "matches catalog projection with %i native payload repetitions",
    async (repeats) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const submitted = vi.spyOn(WorkerTaskPool.prototype, "run");
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
      const page = { data: [thread], nextCursor: "next", backwardsCursor: null };
      const list = harness.client.request("thread/list", { limit: 64 }, { catalogPreview: true });
      // Result-first envelopes must skip nested IDs and escaped strings while routing.
      harness.send({ result: page, id: requestId(harness) });
      await expect(list).resolves.toEqual(
        projectCodexCatalogNativeResponse(page, sanitizeTerminalText),
      );
      expect(parse).not.toHaveBeenCalled();

      const read = harness.client.request(
        "thread/read",
        { threadId: thread.id, includeTurns: false },
        { catalogPreview: true },
      );
      harness.send({ id: requestId(harness, 1), result: { thread } });
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
      harness.send({ id: requestId(harness, 2), result: { thread } });
      await expect(history).resolves.toEqual({ thread });
      expect(parse).toHaveBeenCalledOnce();
      expect(submitted).toHaveBeenCalledTimes(repeats === 1 ? 0 : 2);
    },
  );

  it.each([0, 1])(
    "projects result-first raw-newline pages with %i admitted rows before following notifications",
    async (catalogRows) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const delivered = createDeferred<void>();
      const observed: string[] = [];
      const following = { method: "turn/completed", params: { threadId: "selected" } };
      const followingLine = JSON.stringify(following);
      harness.client.addNotificationHandler((notification) => {
        expect(notification).toEqual(following);
        observed.push(notification.method);
        delivered.resolve();
      });
      const request = harness.client.request(
        "thread/list",
        { limit: 64 },
        {
          catalogPreview: true,
          catalogRows,
          attemptWaiterFinished: () => observed.push("response"),
        },
      );
      const page: JsonObject = {
        data: [
          {
            id: "selected",
            projectId: null,
            preview: `First line\n${"second ".repeat(1_000)}`,
            path: catalogRows ? "/synthetic/selected.jsonl" : "/".repeat(4_097),
          },
          { id: "discarded", path: "/".repeat(4_097), extra: { unneeded: "native payload" } },
        ],
        nextCursor: "next-page",
      };
      const raw = JSON.stringify({ result: page, id: requestId(harness) }).replace("\\n", "\n");
      harness.process.stdout.write(`${raw}\n${followingLine}\n`);
      const response = await request;
      await delivered.promise;
      expect(observed).toEqual(["response", following.method]);
      expect(parse.mock.calls).toEqual([[followingLine]]);
      expect(response).toEqual(
        projectCodexCatalogNativeResponse(page, sanitizeTerminalText, undefined, catalogRows),
      );
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
      harness.client.request(
        "thread/list",
        { limit: 1 },
        {
          catalogPreview: true,
          attemptWaiterFinished: () => observed.push(`${name} response`),
        },
      ),
    );
    const frames = [
      { method: "turn/started", params: { threadId: "thread-1" } },
      {
        id: requestId(harness, 1),
        result: { data: [{ id: "second" }], unused: "x".repeat(64 * 1024) },
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
      { data: [{ id: "second", projectId: null }] },
    ]);
    expect(JSON.parse(await harness.waitForWrite(2))).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it.each([1, 100_000])(
    "discards late cancelled catalog pages with %i preview repeats without disturbing the next request",
    async (repeats) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const abort = new AbortController();
      const cancelled = harness.client.request(
        "thread/list",
        { limit: 64 },
        { catalogPreview: true, signal: abort.signal },
      );
      const rejection = expect(cancelled).rejects.toThrow(/aborted/u);
      abort.abort();
      await rejection;
      const next = harness.client.request("thread/list", { limit: 1 }, { catalogPreview: true });
      harness.send({
        id: requestId(harness),
        result: { data: [{ id: "late", preview: "discarded ".repeat(repeats) }] },
      });
      harness.send({ id: requestId(harness, 1), result: { data: [{ id: "current" }] } });
      await expect(next).resolves.toEqual({ data: [{ id: "current", projectId: null }] });
      expect(parse).not.toHaveBeenCalled();
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it.each(["close", "abort"])(
    "does not read cached previews or deliver an inline response after %s",
    async (cancel) => {
      const harness = createHarness();
      const abort = new AbortController();
      const cache = vi.fn(() => "retained");
      const request = harness.client.request(
        "thread/list",
        {},
        { catalogPreview: true, catalogPreviewCache: cache, signal: abort.signal },
      );
      const rejected = expect(request).rejects.toThrow();
      harness.send({
        id: requestId(harness),
        result: { data: [{ id: "closed", preview: "new" }] },
      });
      if (cancel === "close") {
        harness.client.close();
      } else {
        abort.abort();
      }
      await rejected;
      expect(cache).not.toHaveBeenCalled();
    },
  );

  it("preserves native RPC rejection and keeps projection failures scoped to their request", async () => {
    const harness = createHarness();
    const native = harness.client.request("thread/list", {}, { catalogPreview: true });
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
    const invalid = harness.client.request("thread/list", {}, { catalogPreview: true });
    const invalidRejected = expect(invalid).rejects.toThrow("invalid thread id");
    harness.send({ id: requestId(harness, 1), result: { data: [{ preview: "missing id" }] } });
    await invalidRejected;
    const next = harness.client.request("thread/list", {}, { catalogPreview: true });
    harness.send({ id: requestId(harness, 2), result: { data: [] } });
    await expect(next).resolves.toEqual({ data: [] });
    expect(harness.client.getCloseError()).toBeUndefined();
  });

  it("waits for its real worker to close before closeAndWait completes", async () => {
    const harness = createHarness();
    const pool = await startWorker(harness);
    const retired = createDeferred<void>();
    const release = createDeferred<void>();
    const close = pool.close.bind(pool);
    const closeWorker = vi.spyOn(pool, "close").mockImplementation(async (error) => {
      await close(error);
      retired.resolve();
      await release.promise;
    });
    let finished = false;
    const closing = harness.client.closeAndWait().then((result) => {
      finished = true;
      return result;
    });
    harness.emitExit();
    try {
      await retired.promise;
      expect(closeWorker).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
    } finally {
      release.resolve();
    }
    await expect(closing).resolves.toMatchObject({ exited: true });
  });

  it("pauses stdout and admits only one decode while the worker is busy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const pool = await startWorker(harness);
    const rotation = vi.spyOn(pool, "rotate");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const run = pool.run.bind(pool);
    const snapshots: { activeTasks: number; pendingTasks: number }[] = [];
    const decode = vi.spyOn(pool, "run").mockImplementation(async (input, options) => {
      const result = run(input, options);
      snapshots.push(pool.getSnapshot());
      entered.resolve();
      await release.promise;
      return await result;
    });
    const first = harness.client.request("thread/list", {}, { catalogPreview: true });
    const second = harness.client.request("thread/list", {}, { catalogPreview: true });
    const preview = "x".repeat(256 * 1024);
    harness.send({ id: requestId(harness, 1), result: { data: [{ id: "first", preview }] } });
    try {
      await entered.promise;
      expect(harness.process.stdout.isPaused()).toBe(true);
      const accepted = harness.process.stdout.write(
        `${JSON.stringify({
          id: requestId(harness, 2),
          result: { data: [{ id: "second", preview }] },
        })}\n`,
      );
      expect(accepted).toBe(false);
      expect(decode).toHaveBeenCalledOnce();
      expect(harness.process.stdout.readableLength).toBeGreaterThan(0);
      vi.advanceTimersByTime(120_000);
      expect(rotation).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await expect(Promise.all([first, second])).resolves.toEqual(
      ["first", "second"].map((id) => ({
        data: [{ id, projectId: null, preview: "x".repeat(500) }],
      })),
    );
    expect(decode).toHaveBeenCalledTimes(2);
    expect(
      snapshots.every(({ activeTasks, pendingTasks }) => activeTasks <= 1 && pendingTasks <= 1),
    ).toBe(true);
  });

  it.each(["\n", "\r\n"])(
    "recovers raw newlines and split UTF-8 in worker pages with %j framing",
    async (separator) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const request = harness.client.request("thread/list", {}, { catalogPreview: true });
      const bytes = Buffer.from(
        `{"id":${JSON.stringify(requestId(harness))},"result":{"data":[{"id":"thread","preview":"猫${separator}😀"}]}}${separator}`,
      );
      for (let index = 0; index < bytes.length; index++) {
        harness.process.stdout.write(bytes.subarray(index, index + 1));
      }
      await expect(request).resolves.toEqual({
        data: [{ id: "thread", projectId: null, preview: "猫 😀" }],
      });
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "short", token: "synthetic-secret" },
    { name: "long", token: `synthetic-secret-${"padding".repeat(500)}` },
  ])(
    "redacts malformed worker continuations with a $name token and recovers the next catalog frame",
    async ({ token }) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const request = harness.client.request("thread/list", {}, { catalogPreview: true });
      harness.process.stdout.write(
        `{"id":${JSON.stringify(requestId(harness))},"result":{"token":${JSON.stringify(token)},"data":[{"id":"thread","preview":"first\ninvalid \\q\n`,
      );
      harness.send({ id: requestId(harness), result: { data: [] } });
      await expect(request).resolves.toEqual({ data: [] });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "failed to parse codex app-server message",
        expect.objectContaining({ fragmentCount: 2 }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(warn.mock.calls)).toContain("<redacted>");
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "retains the incomplete recovery byte bound in the worker (complete: %s)",
    async (complete) => {
      const harness = createHarness();
      const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const request = harness.client.request("thread/list", {}, { catalogPreview: true });
      harness.process.stdout.write(
        `{"id":${JSON.stringify(requestId(harness))},"result":{"data":[{"id":"large","preview":"${"x".repeat(8 * 1024 * 1024)}\n`,
      );
      harness.process.stdout.write(complete ? 'last"}]}}\n' : "incomplete\n");
      if (!complete) {
        harness.send({ id: requestId(harness), result: { data: [] } });
      }
      await expect(request).resolves.toEqual({
        data: complete ? [{ id: "large", projectId: null, preview: "x".repeat(500) }] : [],
      });
      expect(warn).toHaveBeenCalledTimes(complete ? 0 : 1);
      expect(parse).not.toHaveBeenCalled();
    },
  );
});
