import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  acquireNativeMcpServer,
  type NativeMcpClientContext,
  type NativeMcpServerEvent,
  type NativeMcpServerView,
} from "./native-mcp-runtime.js";
import {
  context,
  createFixtureRuntime,
  options,
  payload,
  processId,
  writeNativeMcpFixture,
} from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
const runtimes: SessionMcpRuntime[] = [];
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});
afterAll(async () => {
  await receipts.close();
});

async function fixture(era: "legacy" | "modern" = "legacy") {
  const directory = tempDirs.make("native-mcp-owner-");
  const file = path.join(directory, "server.mjs");
  await writeNativeMcpFixture(file, receipts.endpoint, era);
  const create = (requester: string) => {
    const runtime = createFixtureRuntime(directory, file, requester);
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = create("first");
  const acquire = (caller = context(), owner = runtime) =>
    acquireNativeMcpServer(owner, "fixture", caller);
  return { file, create, runtime, acquire };
}

const metadata = { fixture: "kept", nested: { value: 7 } };
const withMetadata = <T extends object>(value: T) => ({ ...value, _meta: metadata });
const sample = (owner: string) => ({
  role: "assistant" as const,
  content: { type: "text" as const, text: `${owner}-sample` },
  model: "fixture",
});
const customResult = (owner: string, selected: string[]) => ({
  action: "accept" as const,
  content: { choice: `${owner}-custom`, nested: { selected } },
  _meta: { acceptedBy: owner },
});
const callTool = (view: NativeMcpServerView, name: string, signal: AbortSignal) =>
  view.callTool({ name }, options(signal));
const toolPayload = async (view: NativeMcpServerView, name: string, signal: AbortSignal) =>
  payload(await callTool(view, name, signal));
const page = (key: string, entries: object[], nextCursor?: string) =>
  withMetadata({ [key]: entries, ...(nextCursor ? { nextCursor } : {}) });
const note = { uri: "fixture://note", mimeType: "text/plain" };
const greeting = { name: "greeting", arguments: { name: "Ada" } };
const completeText = (value: unknown) => ({
  kind: "complete",
  result: { content: [{ type: "text", text: JSON.stringify(value) }] },
});
const completed = <T extends object>(result: T) => ({
  kind: "complete",
  result: withMetadata(result),
});
const notificationMatching = (method: string) =>
  expect.objectContaining({ notification: expect.objectContaining({ method }) });
const releaseViews = (...views: NativeMcpServerView[]) => ({
  async [Symbol.asyncDispose]() {
    await Promise.all(views.map((view) => view.release()));
  },
});
async function continuation(view: NativeMcpServerView, signal: AbortSignal) {
  const response = await callTool(view, "probe", signal);
  if (response.kind !== "input-required") {
    throw new Error("Missing modern continuation");
  }
  return response;
}

describe("private MCP projection operations at the session owner", () => {
  it("keeps complete pages and utility results from a roots-sensitive legacy peer", async ({
    signal,
  }) => {
    const { acquire } = await fixture();
    const caller = context();
    const view = await acquire(caller);
    await using cleanup = releaseViews(view);
    void cleanup;
    expect(view.getProtocolEra()).toBe("legacy");
    expect(view.getProtocolVersion()).toBe("2025-11-25");
    expect(view.getServerInfo()).toEqual({ name: "typed-fixture", version: "1.0.0" });
    expect(view.getInstructions()).toBe("Keep the full envelope.");
    const first = await view.listTools(undefined, options(signal));
    const probe = withMetadata({
      name: "probe",
      title: "Probe title",
      description: JSON.stringify({ roots: caller.roots, capabilities: caller.capabilities }),
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    });
    expect(first).toEqual(page("tools", [probe], "page:2"));
    const prompt = withMetadata({
      name: "greeting",
      description: "Greeting prompt",
      arguments: [{ name: "name", required: true }],
    });
    const pages = [
      [view.listTools, "tools", null],
      [view.listResources, "resources", withMetadata({ ...note, name: "Note" })],
      [
        view.listResourceTemplates,
        "resourceTemplates",
        withMetadata({ uriTemplate: "fixture://{name}", name: "Template" }),
      ],
      [view.listPrompts, "prompts", prompt],
    ] as const;
    for (const [list, key, entry] of pages) {
      if (entry) {
        expect(await list(undefined, options(signal))).toEqual(page(key, [entry], "page:2"));
      }
      expect(await list({ cursor: first.nextCursor }, options(signal))).toEqual(page(key, []));
    }
    expect(await view.readResource({ uri: note.uri }, options(signal))).toEqual(
      completed({
        contents: [withMetadata({ ...note, text: "full resource" })],
      }),
    );
    expect(await view.getPrompt(greeting, options(signal))).toEqual(
      completed({
        description: "Complete greeting",
        messages: [{ role: "user", content: withMetadata({ type: "text", text: "Hello Ada" }) }],
      }),
    );
    expect(
      await view.complete(
        { ref: { type: "ref/prompt", name: "greeting" }, argument: { name: "name", value: "A" } },
        options(signal),
      ),
    ).toEqual(
      withMetadata({
        completion: { values: ["Ada", "Alan"], total: 3, hasMore: true },
      }),
    );
  });

  for (const reason of ["idle", "changed"]) {
    it(`answers capability-context roots while ${reason}`, async ({ signal }) => {
      const { runtime, file, acquire } = await fixture();
      const caller = context();
      const view = await acquire(caller);
      await using cleanup = releaseViews(view);
      void cleanup;
      if (reason === "changed") {
        await view.rootsChanged(options(signal));
        await withinTest(receipts.waitFor(file, "recv notifications/roots/list_changed"), signal);
      }
      expect(runtime.activeLeases).toBe(0);
      receipts.release(file, "request-roots-" + reason);
      await withinTest(receipts.waitFor(file, "roots settled " + reason), signal);
      const report = (await fs.readFile(file + ".log", "utf8"))
        .split("\n")
        .find((line) => line.startsWith("roots " + reason + " "));
      expect(report).toBe("roots " + reason + " " + JSON.stringify({ result: caller.roots }));
      expect(runtime.activeLeases).toBe(0);
    });
  }

  it("reuses identical context while isolating roots and requesters and retiring run-scoped children", async ({
    signal,
  }) => {
    const { runtime, create, file, acquire } = await fixture();
    const sharedContext = {};
    const [first, same, sameRoots] = await Promise.all([
      acquire(context(undefined, sharedContext)),
      acquire(context(undefined, sharedContext)),
      acquire(),
    ]);
    const other = await acquire(context("file:///workspace/b", sharedContext));
    const noRoots = await acquire({ ...context(undefined, sharedContext), capabilities: {} });
    const secondRequester = await acquire(context(undefined, sharedContext), create("second"));
    await using cleanup = releaseViews(first, same, sameRoots, other, noRoots, secondRequester);
    void cleanup;
    const inspect = async (view: typeof first) => toolPayload(view, "probe", signal);
    const original = await inspect(first);
    expect(await inspect(same)).toEqual(original);
    expect(await inspect(sameRoots)).not.toEqual(original);
    expect(await inspect(other)).toMatchObject({
      roots: { roots: [{ uri: "file:///workspace/b", name: "Workspace" }] },
    });
    const isolated = await inspect(other);
    expect(isolated).not.toEqual(original);
    const admittedAt = runtime.lastUsedAt + 10_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(admittedAt);
    try {
      expect(await inspect(noRoots)).toMatchObject({ capabilities: {}, roots: { roots: [] } });
      expect(runtime.lastUsedAt).toBe(admittedAt);
      expect(runtime.activeLeases).toBe(0);
    } finally {
      clock.mockRestore();
    }
    expect(await inspect(secondRequester)).not.toEqual(original);
    expect(runtime.activeLeases).toBe(0);
    await other.release();
    await withinTest(receipts.waitForExit(file + ":" + processId(isolated)), signal);
    await expect(callTool(other, "probe", signal)).rejects.toThrow("released");
    const ordinaryCatalog = await runtime.getCatalog();
    expect(ordinaryCatalog.tools[0]?.description).toBe(
      JSON.stringify({ roots: { roots: [] }, capabilities: {} }),
    );
    const ordinaryResult = await runtime.callTool("fixture", "probe", {});
    const ordinaryText = ordinaryResult.content[0];
    if (ordinaryText?.type !== "text") {
      throw new Error("Expected ordinary MCP tool text");
    }
    expect(JSON.parse(ordinaryText.text)).toMatchObject({ roots: { roots: [] }, capabilities: {} });
    expect((await fs.readFile(file + ".log", "utf8")).match(/^started /gm)).toHaveLength(6);
    expect(await inspect(first)).toEqual(original);
    await first.release();
    expect(await inspect(same)).toEqual(original);
    const closed = createDeferred();
    let throwingListenerCalls = 0;
    same.subscribe((event) => {
      if (event.kind === "closed") {
        throwingListenerCalls += 1;
        throw new Error("fixture subscriber failed");
      }
    });
    same.subscribe((event) => {
      if (event.kind === "closed") {
        closed.resolve();
      }
    });
    await runtime.dispose();
    await withinTest(closed.promise, signal);
    expect(throwingListenerCalls).toBe(1);
  });

  it("binds callbacks and notifications to the caller and rejects revoked work after an await", async ({
    signal,
  }) => {
    const { runtime, file, acquire } = await fixture();
    const samplingRequested = createDeferred();
    const samplingReady = createDeferred();
    let revoked = false;
    let waiting = false;
    const base = context();
    base.capabilities.elicitation = { form: {}, url: {} };
    base.capabilities.sampling = {};
    base.capabilities.extensions = {
      "openai/elicitation": { form: {} },
      "io.openclaw.test/sample-during-list": {},
    };
    const customRequests: Record<string, unknown>[] = [];
    const callbackContext = (owner: string, selected: string[]): NativeMcpClientContext => ({
      ...base,
      createMessage: async () => sample(owner),
      elicit: async () => ({ action: "accept", content: { choice: owner } }),
      elicitCustom: async (params) => {
        customRequests.push(params);
        return customResult(owner, selected);
      },
    });
    const caller = callbackContext("first", ["a", "b"]);
    caller.assertCurrent = () => {
      if (revoked) {
        throw new Error("caller revoked");
      }
    };
    caller.createMessage = async () => {
      if (waiting) {
        samplingRequested.resolve();
        await samplingReady.promise;
      }
      return sample("first");
    };
    caller.elicit = async (params) =>
      params.mode === "url"
        ? { action: "accept" }
        : { action: "accept", content: { choice: "first" } };
    const first = await acquire(caller);
    const secondContext = callbackContext("second", ["b"]);
    const second = await acquire(secondContext);
    const firstEvents: NativeMcpServerEvent[] = [];
    const secondEvents: NativeMcpServerEvent[] = [];
    const changed = createDeferred();
    const urlCompleted = createDeferred();
    const notificationCompletions = new Map([
      ["notifications/elicitation/complete", urlCompleted],
      ["notifications/tools/list_changed", changed],
    ]);
    first.subscribe((event) => {
      firstEvents.push(event);
      if (event.kind === "notification") {
        notificationCompletions.get(event.notification.method)?.resolve();
      }
    });
    second.subscribe((event) => secondEvents.push(event));
    try {
      for (const [view, owner, selected] of [
        [first, "first", ["a", "b"]],
        [second, "second", ["b"]],
      ] as const) {
        expect(await toolPayload(view, "elicit", signal)).toEqual({
          action: "accept",
          content: { choice: owner },
        });
        expect(await toolPayload(view, "elicitCustom", signal)).toEqual(
          customResult(owner, [...selected]),
        );
        expect(await toolPayload(view, "sample", signal)).toEqual(sample(owner));
      }
      const customRequest = {
        message: "Rich form",
        fields: [{ id: "choice", options: ["a", "b"] }],
        _meta: { fixture: "custom" },
      };
      expect(customRequests).toEqual([customRequest, customRequest]);
      expect(await toolPayload(first, "url", signal)).toEqual({ action: "accept" });
      const completion = callTool(second, "completeUrl", signal);
      await withinTest(
        awaitGateBeforeSettlement(
          urlCompleted.promise,
          completion,
          "URL completion did not reach its original view",
        ),
        signal,
      );
      await completion;
      expect(secondEvents).not.toContainEqual(
        notificationMatching("notifications/elicitation/complete"),
      );
      await callTool(first, "notify", signal);
      await withinTest(changed.promise, signal);
      expect(firstEvents).toContainEqual({
        kind: "notification",
        notification: {
          method: "notifications/message",
          params: { level: "info", data: "request-local" },
        },
      });
      expect(secondEvents).not.toContainEqual(notificationMatching("notifications/message"));
      expect(secondEvents).toContainEqual({
        kind: "notification",
        notification: { method: "notifications/tools/list_changed" },
      });
      waiting = true;
      const call = callTool(first, "sample", signal);
      const rejected = expect(call).rejects.toThrow("caller revoked");
      await withinTest(samplingRequested.promise, signal);
      revoked = true;
      samplingReady.resolve();
      await rejected;
      await withinTest(receipts.waitFor(file, "callback refused"), signal);
      expect(runtime.activeLeases).toBe(0);
      await first.release();
      await callTool(second, "notify", signal);
      const refreshed = await acquire(secondContext);
      await using refreshedCleanup = releaseViews(refreshed);
      void refreshedCleanup;
      expect(refreshed.runtime.peekCatalog()?.diagnostics ?? []).toEqual([]);
      await withinTest(receipts.waitFor(file, "listed sample second-sample"), signal);
      const previousPid = processId(await toolPayload(refreshed, "probe", signal));
      await expect(callTool(refreshed, "crash", signal)).rejects.toThrow();
      await withinTest(receipts.waitForExit(file + ":" + previousPid), signal);
      const reconnected = await acquire(secondContext);
      await using reconnectedCleanup = releaseViews(reconnected);
      void reconnectedCleanup;
      expect(processId(await toolPayload(reconnected, "probe", signal))).not.toBe(previousPid);
      await withinTest(receipts.waitFor(file, "listed sample second-sample", 2), signal);
    } finally {
      samplingReady.resolve();
      await Promise.all([first.release(), second.release()]);
    }
  });

  it("forwards progress and retires cancelled legacy work without retaining a lease", async ({
    signal,
  }) => {
    const { runtime, file, acquire } = await fixture();
    const caller = context();
    let view = await acquire(caller);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pid = processId(await toolPayload(view, "probe", signal));
        const abort = new AbortController();
        const progress = createDeferred();
        const releaseToken = `finish-${attempt}`;
        const call = view.callTool(
          { name: "hold", arguments: { releaseToken } },
          {
            ...options(abort.signal),
            onprogress: (value) => {
              expect(value).toEqual({ progress: 1, total: 2, message: "waiting" });
              progress.resolve();
            },
          },
        );
        const rejected = expect(call).rejects.toThrow("cancel test");
        await withinTest(progress.promise, signal);
        expect(runtime.activeLeases).toBe(1);
        abort.abort(new Error("cancel test"));
        await rejected;
        expect(runtime.activeLeases).toBe(0);
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(callTool(view, "probe", signal)).rejects.toThrow("reacquire");
        await view.release();
        view = await acquire(caller);
      }
      expect(await toolPayload(view, "probe", signal)).toMatchObject({
        capabilities: { roots: { listChanged: true } },
      });
      const progress = createDeferred();
      const active = view.callTool(
        { name: "hold", arguments: { releaseToken: "release-view" } },
        { ...options(signal), onprogress: () => progress.resolve() },
      );
      const rejected = expect(active).rejects.toThrow("released");
      await withinTest(progress.promise, signal);
      await view.release();
      expect(runtime.activeLeases).toBe(0);
      await rejected;
    } finally {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        receipts.release(file, `finish-${attempt}`);
      }
      await view.release();
    }
  });

  it("isolates a refused capability context from healthy upstream startup", async ({ signal }) => {
    const { file, acquire } = await fixture();
    const refused = context();
    refused.capabilities.extensions = { "io.openclaw.test/refuse-startup": {} };
    await expect(acquire(refused)).rejects.toThrow();
    await withinTest(receipts.waitFor(file, "initialize refused capabilities"), signal);
    const healthy = await acquire();
    await using cleanup = releaseViews(healthy);
    void cleanup;
    expect(await toolPayload(healthy, "probe", signal)).toMatchObject({
      roots: context().roots,
      capabilities: { roots: { listChanged: true } },
    });
    expect((await fs.readFile(file + ".log", "utf8")).match(/^started /gm)).toHaveLength(2);
  });

  it("preserves owner deadlines, human-input holds, and uncertain child cleanup", async ({
    signal,
  }) => {
    const { runtime, acquire } = await fixture();
    const caller = context();
    const samplingEntered = createDeferred<AbortSignal>();
    const samplingRelease = createDeferred();
    const humanEntered = createDeferred<AbortSignal>();
    const humanRelease = createDeferred();
    caller.capabilities.elicitation = { form: {} };
    caller.capabilities.sampling = {};
    caller.createMessage = async (_params, { signal: callbackSignal }) => {
      samplingEntered.resolve(callbackSignal);
      await withinTest(samplingRelease.promise, callbackSignal);
      return { role: "assistant", content: { type: "text", text: "sample" }, model: "fixture" };
    };
    caller.elicit = async (_params, { signal: callbackSignal }) => {
      humanEntered.resolve(callbackSignal);
      await withinTest(humanRelease.promise, callbackSignal);
      return { action: "accept", content: { choice: "held" } };
    };
    let view = await acquire(caller);
    const timeoutMs = view.runtime.getServerRequestTimeoutMs?.("fixture");
    if (timeoutMs === undefined) {
      throw new Error("Expected negotiated owner's request timeout");
    }
    const pending: Promise<unknown>[] = [];
    try {
      // This deadline retires a real process; its cleanup grace also needs the real clock.
      const sampling = Promise.allSettled([callTool(view, "sample", signal)]);
      pending.push(sampling);
      const samplingSignal = await withinTest(samplingEntered.promise, signal);
      expect(await sampling).toMatchObject([
        { status: "rejected", reason: expect.objectContaining({ message: "Request timed out" }) },
      ]);
      expect(samplingSignal.aborted).toBe(true);
      expect(runtime.activeLeases).toBe(0);
      await expect(callTool(view, "probe", signal)).rejects.toThrow("reacquire");
      await view.release();
      view = await acquire(caller);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const human = Promise.allSettled([callTool(view, "elicit", signal)]);
      pending.push(human);
      const humanSignal = await withinTest(humanEntered.promise, signal);
      await vi.advanceTimersByTimeAsync(timeoutMs + 1);
      expect(humanSignal.aborted).toBe(false);
      humanRelease.resolve();
      expect(await human).toMatchObject([
        {
          status: "fulfilled",
          value: completeText({ action: "accept", content: { choice: "held" } }),
        },
      ]);
      expect(runtime.activeLeases).toBe(0);
    } finally {
      samplingRelease.resolve();
      humanRelease.resolve();
      vi.useRealTimers();
      await Promise.all(pending);
      await view.release();
    }
    const uncertain = await acquire(context("file:///workspace/uncertain"));
    const join = uncertain.runtime.joinCleanup?.bind(uncertain.runtime);
    if (!join || !runtime.joinCleanup) {
      throw new Error("Expected lifecycle cleanup join");
    }
    const joinFailure = vi
      .spyOn(uncertain.runtime, "joinCleanup")
      .mockImplementationOnce(async () => {
        await join();
        throw new Error("fixture cleanup uncertain");
      });
    try {
      await expect(uncertain.release()).rejects.toThrow("fixture cleanup uncertain");
      joinFailure.mockRestore();
      await expect(runtime.joinCleanup()).rejects.toThrow();
    } finally {
      joinFailure.mockRestore();
      await expect(uncertain.release()).rejects.toThrow("fixture cleanup uncertain");
    }
  });

  it("records the modern era and keeps input-required continuations owned by their view", async ({
    signal,
  }) => {
    const { runtime, file, acquire } = await fixture("modern");
    let current = true;
    const caller = context();
    caller.assertCurrent = () => {
      if (!current) {
        throw new Error("modern caller revoked");
      }
    };
    const first = await acquire(caller);
    const second = await acquire({ ...caller, assertCurrent() {} });
    await using cleanup = releaseViews(first, second);
    void cleanup;
    expect(first.getProtocolEra()).toBe("modern");
    expect(first.getProtocolVersion()).toBe("2026-07-28");
    const pending = await continuation(first, signal);
    expect(pending.kind).toBe("input-required");
    expect(pending.result).toMatchObject({
      resultType: "input_required",
      requestState: "fixture-state",
      inputRequests: { roots: { method: "roots/list" } },
      _meta: metadata,
    });
    const resumed = await pending.resume({ roots: caller.roots }, options(signal));
    expect(payload(resumed)).toMatchObject({ responses: { roots: caller.roots } });
    expect(() => pending.resume({ roots: caller.roots }, options(signal))).toThrow(
      "already resumed",
    );
    const revoked = await continuation(first, signal);
    current = false;
    expect(() => revoked.resume({ roots: caller.roots }, options(signal))).toThrow(
      "modern caller revoked",
    );
    const independent = await continuation(second, signal);
    expect(
      payload(await independent.resume({ roots: context().roots }, options(signal))),
    ).toMatchObject({ responses: { roots: context().roots } });
    expect((await fs.readFile(file + ".log", "utf8")).match(/^resumed /gm)).toHaveLength(2);
    expect(runtime.activeLeases).toBe(0);
  });
});
