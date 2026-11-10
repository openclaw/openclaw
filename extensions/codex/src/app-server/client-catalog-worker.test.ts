import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  projectCodexCatalogNativeResponse,
  projectCodexCatalogNativeThread,
} from "../session-catalog-native-projection.js";
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
  it.each([
    { nextAction: "page", fails: false },
    { nextAction: "close", fails: false },
    { nextAction: "page", fails: true },
    { nextAction: "close", fails: true },
  ])("joins idle stop: $nextAction, failure=$fails", async ({ nextAction, fails }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const pool = await startWorker(harness);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the intercepted worker below.
    const terminate = Worker.prototype.terminate;
    const termination = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementationOnce(async function (this: Worker) {
        const code = fails ? 0 : await terminate.call(this);
        entered.resolve();
        await release.promise;
        return code;
      });
    vi.advanceTimersByTime(60_000);
    await entered.promise;
    expect(termination).toHaveBeenCalledOnce();
    expect(harness.stdinDestroyed).toBe(false);
    expect(harness.client.getCloseError()).toBeUndefined();
    const page = harness.list();
    const outcome =
      nextAction === "close"
        ? expect(page).rejects.toThrow(/closed/u)
        : fails
          ? expect(page).rejects.toThrow("synthetic worker stop failed")
          : expect(page).resolves.toEqual({ data: [{ id: "queued", projectId: null }] });
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
      expect(pool.getSnapshot().workersCreated).toBe(1);
      expect(closed).toBe(false);
    } finally {
      if (fails) {
        release.reject(new Error("synthetic worker stop failed"));
      } else {
        release.resolve();
      }
    }
    await outcome;
    if (!fails && !closing) {
      // Recurring pages keep the replacement warm across minute-long idle gaps.
      for (let index = 2; index <= 3; index++) {
        vi.advanceTimersByTime(60_000);
        const next = harness.list();
        harness.reply({ data: [], unused: "x".repeat(64 * 1024) }, index);
        await expect(next).resolves.toEqual({ data: [] });
      }
      expect(pool.getSnapshot().workersCreated).toBe(2);
    }
    harness.emitExit();
    await (closing ?? harness.client.closeAndWait());
    if (fails) {
      expect(termination).toHaveBeenCalledTimes(2);
    }
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

  it.each([0, 1])(
    "orders result-first pages before notifications (%i rows)",
    async (catalogRows) => {
      const harness = createHarness();
      const delivered = createDeferred<void>();
      const observed: string[] = [];
      const following = { method: "turn/completed", params: { threadId: "selected" } };
      const followingLine = JSON.stringify(following);
      harness.client.addNotificationHandler((notification) => {
        expect(notification).toEqual(following);
        observed.push(notification.method);
        delivered.resolve();
      });
      const request = harness.list(
        { limit: 64 },
        {
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
      const raw = JSON.stringify({ result: page, id: requestId(harness) });
      harness.process.stdout.write(`${raw}\n${followingLine}\n`);
      const response = await request;
      await delivered.promise;
      expect(observed).toEqual(["response", following.method]);
      expect(parse.mock.calls).toEqual([[followingLine, expect.any(Function)]]);
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
