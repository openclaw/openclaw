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
  return { file, create, runtime: create("first") };
}

const metadata = { fixture: "kept", nested: { value: 7 } };

describe("private MCP projection operations at the session owner", () => {
  it("keeps complete pages and utility results from a roots-sensitive legacy peer", async ({
    signal,
  }) => {
    const { runtime } = await fixture();
    const caller = context();
    const view = await acquireNativeMcpServer(runtime, "fixture", caller);
    try {
      expect(view.getProtocolEra()).toBe("legacy");
      expect(view.getProtocolVersion()).toBe("2025-11-25");
      expect(view.getServerInfo()).toEqual({ name: "typed-fixture", version: "1.0.0" });
      expect(view.getInstructions()).toBe("Keep the full envelope.");
      const first = await view.listTools(undefined, options(signal));
      expect(first).toEqual({
        nextCursor: "page:2",
        _meta: metadata,
        tools: [
          {
            name: "probe",
            title: "Probe title",
            description: JSON.stringify({ roots: caller.roots, capabilities: caller.capabilities }),
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: metadata,
          },
        ],
      });
      expect(await view.listTools({ cursor: first.nextCursor }, options(signal))).toEqual({
        tools: [],
        _meta: metadata,
      });
      expect(await view.listResources(undefined, options(signal))).toEqual({
        resources: [
          { uri: "fixture://note", name: "Note", mimeType: "text/plain", _meta: metadata },
        ],
        nextCursor: "page:2",
        _meta: metadata,
      });
      expect(await view.listResourceTemplates(undefined, options(signal))).toEqual({
        resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "Template", _meta: metadata }],
        nextCursor: "page:2",
        _meta: metadata,
      });
      expect(await view.listPrompts(undefined, options(signal))).toEqual({
        prompts: [
          {
            name: "greeting",
            description: "Greeting prompt",
            arguments: [{ name: "name", required: true }],
            _meta: metadata,
          },
        ],
        nextCursor: "page:2",
        _meta: metadata,
      });
      expect(await view.listResources({ cursor: "page:2" }, options(signal))).toEqual({
        resources: [],
        _meta: metadata,
      });
      expect(await view.listResourceTemplates({ cursor: "page:2" }, options(signal))).toEqual({
        resourceTemplates: [],
        _meta: metadata,
      });
      expect(await view.listPrompts({ cursor: "page:2" }, options(signal))).toEqual({
        prompts: [],
        _meta: metadata,
      });
      expect(await view.readResource({ uri: "fixture://note" }, options(signal))).toEqual({
        kind: "complete",
        result: {
          contents: [
            {
              uri: "fixture://note",
              mimeType: "text/plain",
              text: "full resource",
              _meta: metadata,
            },
          ],
          _meta: metadata,
        },
      });
      expect(
        await view.getPrompt({ name: "greeting", arguments: { name: "Ada" } }, options(signal)),
      ).toEqual({
        kind: "complete",
        result: {
          description: "Complete greeting",
          messages: [
            { role: "user", content: { type: "text", text: "Hello Ada", _meta: metadata } },
          ],
          _meta: metadata,
        },
      });
      expect(
        await view.complete(
          { ref: { type: "ref/prompt", name: "greeting" }, argument: { name: "name", value: "A" } },
          options(signal),
        ),
      ).toEqual({
        completion: { values: ["Ada", "Alan"], total: 3, hasMore: true },
        _meta: metadata,
      });
    } finally {
      await view.release();
    }
  });

  for (const reason of ["idle", "changed"]) {
    it(`answers capability-context roots while ${reason}`, async ({ signal }) => {
      const { runtime, file } = await fixture();
      const caller = context();
      const view = await acquireNativeMcpServer(runtime, "fixture", caller);
      try {
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
      } finally {
        await view.release();
      }
    });
  }

  it("reuses identical context while isolating roots and requesters and retiring run-scoped children", async ({
    signal,
  }) => {
    const { runtime, create, file } = await fixture();
    const sharedContext = {};
    const [first, same, sameRoots] = await Promise.all([
      acquireNativeMcpServer(runtime, "fixture", context(undefined, sharedContext)),
      acquireNativeMcpServer(runtime, "fixture", context(undefined, sharedContext)),
      acquireNativeMcpServer(runtime, "fixture", context()),
    ]);
    const other = await acquireNativeMcpServer(
      runtime,
      "fixture",
      context("file:///workspace/b", sharedContext),
    );
    const noRoots = await acquireNativeMcpServer(runtime, "fixture", {
      ...context(undefined, sharedContext),
      capabilities: {},
    });
    const secondRequester = await acquireNativeMcpServer(
      create("second"),
      "fixture",
      context(undefined, sharedContext),
    );
    try {
      const inspect = async (view: typeof first) =>
        payload(await view.callTool({ name: "probe" }, options(signal)));
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
      await expect(other.callTool({ name: "probe" }, options(signal))).rejects.toThrow("released");
      const ordinaryCatalog = await runtime.getCatalog();
      expect(ordinaryCatalog.tools[0]?.description).toBe(
        JSON.stringify({ roots: { roots: [] }, capabilities: {} }),
      );
      const ordinaryResult = await runtime.callTool("fixture", "probe", {});
      const ordinaryText = ordinaryResult.content[0];
      if (ordinaryText?.type !== "text") {
        throw new Error("Expected ordinary MCP tool text");
      }
      expect(JSON.parse(ordinaryText.text)).toMatchObject({
        roots: { roots: [] },
        capabilities: {},
      });
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
    } finally {
      await Promise.all([
        first.release(),
        same.release(),
        sameRoots.release(),
        other.release(),
        noRoots.release(),
        secondRequester.release(),
      ]);
    }
  });

  it("binds callbacks and notifications to the caller and rejects revoked work after an await", async ({
    signal,
  }) => {
    const { runtime, file } = await fixture();
    const samplingRequested = createDeferred();
    const samplingReady = createDeferred();
    let revoked = false;
    let waiting = false;
    const caller = context();
    caller.assertCurrent = () => {
      if (revoked) {
        throw new Error("caller revoked");
      }
    };
    caller.capabilities.elicitation = { form: {}, url: {} };
    caller.capabilities.sampling = {};
    caller.createMessage = async () => {
      if (waiting) {
        samplingRequested.resolve();
        await samplingReady.promise;
      }
      return {
        role: "assistant",
        content: { type: "text", text: "first-sample" },
        model: "fixture",
      };
    };
    caller.capabilities.extensions = {
      "openai/elicitation": { form: {} },
      "io.openclaw.test/sample-during-list": {},
    };
    const customRequests: Record<string, unknown>[] = [];
    caller.elicitCustom = async (params) => {
      customRequests.push(params);
      return {
        action: "accept",
        content: { choice: "first-custom", nested: { selected: ["a", "b"] } },
        _meta: { acceptedBy: "first" },
      };
    };
    caller.elicit = async (params) =>
      params.mode === "url"
        ? { action: "accept" }
        : { action: "accept", content: { choice: "first" } };
    const first = await acquireNativeMcpServer(runtime, "fixture", caller);
    const secondContext: NativeMcpClientContext = {
      ...caller,
      assertCurrent() {},
      elicit: async () => ({ action: "accept", content: { choice: "second" } }),
      createMessage: async () => ({
        role: "assistant",
        content: { type: "text", text: "second-sample" },
        model: "fixture",
      }),
      elicitCustom: async (params) => {
        customRequests.push(params);
        return {
          action: "accept",
          content: { choice: "second-custom", nested: { selected: ["b"] } },
          _meta: { acceptedBy: "second" },
        };
      },
    };
    const second = await acquireNativeMcpServer(runtime, "fixture", secondContext);
    const firstEvents: NativeMcpServerEvent[] = [];
    const secondEvents: NativeMcpServerEvent[] = [];
    const changed = createDeferred();
    const urlCompleted = createDeferred();
    first.subscribe((event) => {
      firstEvents.push(event);
      if (
        event.kind === "notification" &&
        event.notification.method === "notifications/elicitation/complete"
      ) {
        urlCompleted.resolve();
      }
      if (
        event.kind === "notification" &&
        event.notification.method === "notifications/tools/list_changed"
      ) {
        changed.resolve();
      }
    });
    second.subscribe((event) => secondEvents.push(event));
    try {
      expect(payload(await first.callTool({ name: "elicit" }, options(signal)))).toEqual({
        action: "accept",
        content: { choice: "first" },
      });
      expect(payload(await second.callTool({ name: "elicit" }, options(signal)))).toEqual({
        action: "accept",
        content: { choice: "second" },
      });
      expect(payload(await first.callTool({ name: "elicitCustom" }, options(signal)))).toEqual({
        action: "accept",
        content: { choice: "first-custom", nested: { selected: ["a", "b"] } },
        _meta: { acceptedBy: "first" },
      });
      expect(payload(await second.callTool({ name: "elicitCustom" }, options(signal)))).toEqual({
        action: "accept",
        content: { choice: "second-custom", nested: { selected: ["b"] } },
        _meta: { acceptedBy: "second" },
      });
      expect(customRequests).toEqual([
        {
          message: "Rich form",
          fields: [{ id: "choice", options: ["a", "b"] }],
          _meta: { fixture: "custom" },
        },
        {
          message: "Rich form",
          fields: [{ id: "choice", options: ["a", "b"] }],
          _meta: { fixture: "custom" },
        },
      ]);
      expect(payload(await first.callTool({ name: "sample" }, options(signal)))).toEqual({
        role: "assistant",
        content: { type: "text", text: "first-sample" },
        model: "fixture",
      });
      expect(payload(await second.callTool({ name: "sample" }, options(signal)))).toEqual({
        role: "assistant",
        content: { type: "text", text: "second-sample" },
        model: "fixture",
      });
      expect(payload(await first.callTool({ name: "url" }, options(signal)))).toEqual({
        action: "accept",
      });
      const completion = second.callTool({ name: "completeUrl" }, options(signal));
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
        expect.objectContaining({
          notification: expect.objectContaining({ method: "notifications/elicitation/complete" }),
        }),
      );
      await first.callTool({ name: "notify" }, options(signal));
      await withinTest(changed.promise, signal);
      expect(firstEvents).toContainEqual({
        kind: "notification",
        notification: {
          method: "notifications/message",
          params: { level: "info", data: "request-local" },
        },
      });
      expect(secondEvents).not.toContainEqual(
        expect.objectContaining({
          notification: expect.objectContaining({ method: "notifications/message" }),
        }),
      );
      expect(secondEvents).toContainEqual({
        kind: "notification",
        notification: { method: "notifications/tools/list_changed" },
      });
      waiting = true;
      const call = first.callTool({ name: "sample" }, options(signal));
      const rejected = expect(call).rejects.toThrow("caller revoked");
      await withinTest(samplingRequested.promise, signal);
      revoked = true;
      samplingReady.resolve();
      await rejected;
      await withinTest(receipts.waitFor(file, "callback refused"), signal);
      expect(runtime.activeLeases).toBe(0);
      await first.release();
      await second.callTool({ name: "notify" }, options(signal));
      const refreshed = await acquireNativeMcpServer(runtime, "fixture", secondContext);
      try {
        expect(refreshed.runtime.peekCatalog()?.diagnostics ?? []).toEqual([]);
        await withinTest(receipts.waitFor(file, "listed sample second-sample"), signal);
        const previousPid = processId(
          payload(await refreshed.callTool({ name: "probe" }, options(signal))),
        );
        await expect(refreshed.callTool({ name: "crash" }, options(signal))).rejects.toThrow();
        await withinTest(receipts.waitForExit(file + ":" + previousPid), signal);
        const reconnected = await acquireNativeMcpServer(runtime, "fixture", secondContext);
        try {
          expect(
            processId(payload(await reconnected.callTool({ name: "probe" }, options(signal)))),
          ).not.toBe(previousPid);
          await withinTest(receipts.waitFor(file, "listed sample second-sample", 2), signal);
        } finally {
          await reconnected.release();
        }
      } finally {
        await refreshed.release();
      }
    } finally {
      samplingReady.resolve();
      await Promise.all([first.release(), second.release()]);
    }
  });

  it("forwards progress and retires cancelled legacy work without retaining a lease", async ({
    signal,
  }) => {
    const { runtime, file } = await fixture();
    const caller = context();
    let view = await acquireNativeMcpServer(runtime, "fixture", caller);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pid = processId(payload(await view.callTool({ name: "probe" }, options(signal))));
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
        await expect(view.callTool({ name: "probe" }, options(signal))).rejects.toThrow(
          "reacquire",
        );
        await view.release();
        view = await acquireNativeMcpServer(runtime, "fixture", caller);
      }
      expect(payload(await view.callTool({ name: "probe" }, options(signal)))).toMatchObject({
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
    const { runtime, file } = await fixture();
    const refused = context();
    refused.capabilities.extensions = { "io.openclaw.test/refuse-startup": {} };
    await expect(acquireNativeMcpServer(runtime, "fixture", refused)).rejects.toThrow();
    await withinTest(receipts.waitFor(file, "initialize refused capabilities"), signal);
    const healthy = await acquireNativeMcpServer(runtime, "fixture", context());
    try {
      expect(payload(await healthy.callTool({ name: "probe" }, options(signal)))).toMatchObject({
        roots: context().roots,
        capabilities: { roots: { listChanged: true } },
      });
      expect((await fs.readFile(file + ".log", "utf8")).match(/^started /gm)).toHaveLength(2);
    } finally {
      await healthy.release();
    }
  });

  it("preserves owner deadlines, human-input holds, and uncertain child cleanup", async ({
    signal,
  }) => {
    const { runtime } = await fixture();
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
    let view = await acquireNativeMcpServer(runtime, "fixture", caller);
    const timeoutMs = view.runtime.getServerRequestTimeoutMs?.("fixture");
    if (timeoutMs === undefined) {
      throw new Error("Expected negotiated owner's request timeout");
    }
    const pending: Promise<unknown>[] = [];
    try {
      // This deadline retires a real process; its cleanup grace also needs the real clock.
      const sampling = Promise.allSettled([view.callTool({ name: "sample" }, options(signal))]);
      pending.push(sampling);
      const samplingSignal = await withinTest(samplingEntered.promise, signal);
      expect(await sampling).toMatchObject([
        { status: "rejected", reason: expect.objectContaining({ message: "Request timed out" }) },
      ]);
      expect(samplingSignal.aborted).toBe(true);
      expect(runtime.activeLeases).toBe(0);
      await expect(view.callTool({ name: "probe" }, options(signal))).rejects.toThrow("reacquire");
      await view.release();
      view = await acquireNativeMcpServer(runtime, "fixture", caller);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const human = Promise.allSettled([view.callTool({ name: "elicit" }, options(signal))]);
      pending.push(human);
      const humanSignal = await withinTest(humanEntered.promise, signal);
      await vi.advanceTimersByTimeAsync(timeoutMs + 1);
      expect(humanSignal.aborted).toBe(false);
      humanRelease.resolve();
      expect(await human).toMatchObject([
        {
          status: "fulfilled",
          value: {
            kind: "complete",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ action: "accept", content: { choice: "held" } }),
                },
              ],
            },
          },
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
    const uncertain = await acquireNativeMcpServer(
      runtime,
      "fixture",
      context("file:///workspace/uncertain"),
    );
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
    const { runtime, file } = await fixture("modern");
    let current = true;
    const caller = context();
    caller.assertCurrent = () => {
      if (!current) {
        throw new Error("modern caller revoked");
      }
    };
    const first = await acquireNativeMcpServer(runtime, "fixture", caller);
    const second = await acquireNativeMcpServer(runtime, "fixture", {
      ...caller,
      assertCurrent() {},
    });
    try {
      expect(first.getProtocolEra()).toBe("modern");
      expect(first.getProtocolVersion()).toBe("2026-07-28");
      const pending = await first.callTool({ name: "probe" }, options(signal));
      expect(pending.kind).toBe("input-required");
      if (pending.kind !== "input-required") {
        throw new Error("Missing modern continuation");
      }
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
      const revoked = await first.callTool({ name: "probe" }, options(signal));
      if (revoked.kind !== "input-required") {
        throw new Error("Missing second continuation");
      }
      current = false;
      expect(() => revoked.resume({ roots: caller.roots }, options(signal))).toThrow(
        "modern caller revoked",
      );
      const independent = await second.callTool({ name: "probe" }, options(signal));
      if (independent.kind !== "input-required") {
        throw new Error("Missing independent continuation");
      }
      expect(
        payload(await independent.resume({ roots: context().roots }, options(signal))),
      ).toMatchObject({ responses: { roots: context().roots } });
      expect((await fs.readFile(file + ".log", "utf8")).match(/^resumed /gm)).toHaveLength(2);
      expect(runtime.activeLeases).toBe(0);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });
});
