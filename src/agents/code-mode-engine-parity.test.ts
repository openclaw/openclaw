import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as executorRuntime from "./code-mode-executor.js";
import { controlledTool } from "./code-mode.controlled-tool.test-support.js";
import {
  createCatalogCodeModeHarness,
  jsonTool,
  pluginToolWithExecute,
  resultDetails,
  resetCodeModeTestState,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";

describe.each(["node", "quickjs"] as const)("%s guest contract across checkpoints", (executor) => {
  afterEach(resetCodeModeTestState);
  afterEach(() => vi.restoreAllMocks());

  it("continues immediate required replies without serializing retained guest state", async () => {
    const fixture = jsonTool("fixture_echo", { value: 7 });
    const h = createCatalogCodeModeHarness([fixture], {
      codeMode: { executor, maxSnapshotBytes: 4 * 1024 * 1024 },
    });
    const run = vi.spyOn(executorRuntime, "runCodeModeExecutor");
    const result = await h.run(
      `const retained = new Uint8Array(8 * 1024 * 1024); retained[0] = 42;
       let total = 0;
       for (let i = 0; i < 4; i++) total += (await fixture_echo({})).value;
       return { total, retained: retained[0] };`,
      "required-ready",
      { awaitResults: true },
    );
    expect(result).toMatchObject({ status: "completed", value: { total: 28, retained: 42 } });
    expect(fixture.execute).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.map(([input]) => input.kind)).toEqual(["exec"]);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["pressure", "abort", "catalog disposal"] as const)(
    "honors %s while an immediate required reply settles",
    async (outcome) => {
      const pressure = new AbortController();
      const abort = new AbortController();
      const fixture = pluginToolWithExecute("fixture_ready", "Immediate reply", async () => {
        if (outcome === "pressure") {
          pressure.abort();
        } else if (outcome === "abort") {
          abort.abort();
        } else {
          clearToolSearchCatalog(h.ctx);
        }
        return { content: [], details: 7 };
      });
      const effect = jsonTool("fixture_after", { done: true });
      const h = createCatalogCodeModeHarness([fixture, effect], { codeMode: { executor } });
      const commands: string[] = [];
      const run = executorRuntime.runCodeModeExecutor;
      let injected = false;
      vi.spyOn(executorRuntime, "runCodeModeExecutor").mockImplementation((input, options) => {
        const inline = options.inlineHost;
        return run(input, {
          ...options,
          ...(inline
            ? {
                inlineHost: {
                  ...inline,
                  onBoundary: async (boundary, context) => {
                    const first = !injected;
                    injected = true;
                    const command = await inline.onBoundary(
                      boundary,
                      first ? { ...context, yieldSignal: pressure.signal } : context,
                    );
                    commands.push(command.kind);
                    return command;
                  },
                },
              }
            : {}),
        });
      });
      const result = resultDetails(
        await h.tools[0]!.execute(
          "ready-lifetime",
          { code: "await fixture_ready({}); return await fixture_after({});", awaitResults: true },
          abort.signal,
        ),
      );
      expect(result).toMatchObject(
        outcome === "pressure"
          ? { status: "completed", value: { done: true } }
          : { status: "failed", code: "aborted" },
      );
      if (outcome === "pressure") {
        expect(commands[0]).toBe("checkpoint");
      }
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(effect.execute).toHaveBeenCalledTimes(outcome === "pressure" ? 1 : 0);
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
    },
  );

  it.each([false, true])(
    "retains joined results without replay (awaitResults=%s)",
    async (required) => {
      const gated = controlledTool(jsonTool("fixture_read", { value: "ok" }));
      const failure = pluginToolWithExecute("fixture_failure", "Synthetic failure", async () => {
        throw new Error("fixture unavailable");
      });
      const h = createCatalogCodeModeHarness([gated.tool, failure], { codeMode: { executor } });
      const checkpoint = createDeferred();
      const run = executorRuntime.runCodeModeExecutor;
      if (required) {
        vi.spyOn(executorRuntime, "runCodeModeExecutor").mockImplementation(async (...args) => {
          const result = await run(...args);
          if (
            result.status === "waiting" &&
            result.pendingRequests.some(
              (request) => request.method === "callValue" && request.args[0] === "fixture_read",
            )
          ) {
            checkpoint.resolve();
          }
          return result;
        });
      }
      const pending = h.run(
        `
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const bytes = encoder.encode("checkpoint 🦊");
        globalThis.previousCell = true;
        const [read] = await catalog.search("fixture_read");
        const docs = (await API.read("results.d.ts")).content;
        const joined = Promise.all([
          read({}),
          fixture_failure({}).catch(error => error.message),
        ]);
        text("before");
        ${required ? "" : "await yield_control();"}
        const values = await joined;
        const saved = await results.save(values);
        const loaded = await results.load(saved.id);
        const deleted = await results.delete(saved.id);
        text("after");
        return {
          loaded, deleted, encoding: decoder.decode(bytes),
          documented: docs.includes("results"),
          hostGlobals: [typeof process, typeof require, typeof fetch],
        };
      `,
        "parity",
        { awaitResults: required },
      );
      try {
        const reached = await Promise.race([
          gated.started.promise.then(() => ({ kind: "started" as const })),
          pending.then((result) => ({ kind: "returned" as const, result })),
        ]);
        if (reached.kind === "returned") {
          expect(reached.result.status, JSON.stringify(reached.result)).toBe("waiting");
          await gated.started.promise;
        }
        // Ordinary execution must really park before the host tool settles. This
        // catches snapshot corruption and accidental action replay on QuickJS resume.
        const first = required ? undefined : await pending;
        if (required) {
          const parked = await Promise.race([
            checkpoint.promise.then(() => true),
            pending.then(() => false),
          ]);
          expect(parked).toBe(true);
        }
        if (first) {
          expect(first).toMatchObject({
            status: "waiting",
            output: [{ type: "text", text: "before" }],
          });
        }
        gated.release.resolve();
        const result = required
          ? await pending
          : await waitUntilCompleted({ details: first!, waitTool: h.tools[1]! });
        expect(result).toMatchObject({
          status: "completed",
          value: {
            loaded: [{ value: "ok" }, "fixture unavailable"],
            deleted: true,
            encoding: "checkpoint 🦊",
            documented: true,
            hostGlobals: ["undefined", "undefined", "undefined"],
          },
          output: required
            ? [
                { type: "text", text: "before" },
                { type: "text", text: "after" },
              ]
            : [{ type: "text", text: "after" }],
        });
        expect(gated.tool.execute).toHaveBeenCalledTimes(1);
        expect(failure.execute).toHaveBeenCalledTimes(1);
        expect(await h.complete("return typeof previousCell;")).toMatchObject({
          status: "completed",
          value: "undefined",
        });
        expect(testing.activeRuns.size).toBe(0);
        expect(testing.resumingRunIds.size).toBe(0);
      } finally {
        gated.release.resolve();
        await pending;
      }
    },
  );

  it("drains both immediate and held unawaited effects before completing", async () => {
    const immediate = jsonTool("fixture_ready", { value: 7 });
    const gated = controlledTool(jsonTool("fixture_read", { value: "ok" }));
    const h = createCatalogCodeModeHarness([immediate, gated.tool], { codeMode: { executor } });
    const checkpoint = createDeferred();
    const run = executorRuntime.runCodeModeExecutor;
    vi.spyOn(executorRuntime, "runCodeModeExecutor").mockImplementation(async (...args) => {
      const result = await run(...args);
      if (
        result.status === "waiting" &&
        result.settlementMode.kind === "draining" &&
        result.pendingRequests.some(
          (request) => request.method === "callValue" && request.args[0] === "fixture_read",
        )
      ) {
        checkpoint.resolve();
      }
      return result;
    });
    const pending = h.run("void fixture_ready({}); void fixture_read({}); return 42;", "drain", {
      awaitResults: true,
    });
    try {
      expect(
        await Promise.race([
          checkpoint.promise.then(() => "parked"),
          pending.then(() => "finished"),
        ]),
      ).toBe("parked");
      await gated.started.promise;
      expect(immediate.execute).toHaveBeenCalledOnce();
      gated.release.resolve();
      expect(await pending).toMatchObject({ status: "completed", value: 42 });
      expect(gated.tool.execute).toHaveBeenCalledOnce();
      expect(immediate.execute).toHaveBeenCalledOnce();
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
    } finally {
      gated.release.resolve();
      await pending;
    }
  });
});

describe("QuickJS retained allocation limits", () => {
  afterEach(resetCodeModeTestState);

  it.each([false, true])(
    "bounds retained typed arrays after checkpoint=%s and recovers",
    async (checkpoint) => {
      const h = createCatalogCodeModeHarness([], {
        codeMode: {
          executor: "quickjs",
          memoryLimitBytes: 16 * 1024 * 1024,
          maxSnapshotBytes: 32 * 1024 * 1024,
        },
      });
      const first = await h.run(`
      const retained = new Uint8Array(1024 * 1024); retained[0] = 7;
      ${checkpoint ? "await yield_control();" : ""}
      const buffers = [];
      try {
        for (let i = 0; i < 32; i++) {
          const bytes = new Uint8Array(1024 * 1024);
          bytes.fill(i); buffers.push(bytes);
        }
        return { bounded: false };
      } catch (error) {
        return { bounded: /out of memory/.test(error.message), count: buffers.length, retained: retained[0] };
      }
    `);
      if (checkpoint) {
        expect(first.status).toBe("waiting");
      }
      const result = await waitUntilCompleted({ details: first, waitTool: h.tools[1]! });
      expect(result).toMatchObject({ status: "completed", value: { bounded: true, retained: 7 } });
      expect((result.value as { count: number }).count).toBeLessThan(16);
      expect(await h.complete("return 42;")).toMatchObject({ status: "completed", value: 42 });
      expect(testing.activeRuns.size).toBe(0);
    },
  );
});
