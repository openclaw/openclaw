import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  getActiveAgentRingZeroTools,
  runWithAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const abortError = { name: "AbortError", message: "Aborted" };
const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
const emptyResult = () => ({ content: [], details: {} });

function tool(execute: AnyAgentTool["execute"], name = "tool"): AnyAgentTool {
  return { ...stubTool(name), label: name, execute };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function yieldTool(runAbort: AbortController, onYield = () => runAbort.abort(handoffReason)) {
  return wrapToolWithAbortSignal(
    createSessionsYieldTool({ sessionId: "requester", claimYield: () => true, onYield }),
    runAbort.signal,
  );
}

describe("wrapToolWithAbortSignal", () => {
  it("handles a tool rejection when execute aborts the run synchronously", async () => {
    const runAbort = new AbortController();
    const pending = deferred<never>();
    const wrapped = wrapToolWithAbortSignal(
      tool(() => {
        runAbort.abort();
        return pending.promise;
      }),
      runAbort.signal,
    );
    await expect(wrapped.execute("call", {})).rejects.toMatchObject(abortError);
    // Vitest reports an unhandled late rejection if the losing promise is detached incorrectly.
    pending.reject(new Error("tool observed the abort"));
    await flushMicrotasks();
  });

  it("still aborts a concurrent sibling when sessions_yield hands off the run", async () => {
    const runAbort = new AbortController();
    const sibling = wrapToolWithAbortSignal(
      tool(() => new Promise<never>(() => {})),
      runAbort.signal,
    );
    const aborted = expect(sibling.execute("sibling", {})).rejects.toMatchObject(abortError);
    const result = await yieldTool(runAbort).execute("yield", {});
    expect(result).toMatchObject({ details: { status: "yielded" } });
    expect(result).not.toHaveProperty("details.message");
    await aborted;
  });

  it("preserves the handoff when distinct run and per-call signals both yield", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const wrapped = yieldTool(runAbort, () => {
      runAbort.abort(handoffReason);
      callAbort.abort(handoffReason);
    });
    await expect(wrapped.execute("yield", {}, callAbort.signal)).resolves.toMatchObject({
      details: { status: "yielded" },
    });
    expect(runAbort.signal.reason).toBe(handoffReason);
    expect(callAbort.signal.reason).toBe(handoffReason);
  });

  it("rejects a caller-authored lookalike handoff without an owner-authored handoff", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      tool(() => new Promise<never>(() => {}), "sessions_yield"),
      runAbort.signal,
    );
    const execution = wrapped.execute("yield", {}, callAbort.signal);
    callAbort.abort(handoffReason);
    await expect(execution).rejects.toMatchObject(abortError);
    expect(runAbort.signal.aborted).toBe(false);
  });

  it("rejects sessions_yield when its run owner aborts with a disabled handoff flag", async () => {
    const runAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      tool(async () => {
        runAbort.abort({ code: "sessions_yield", turnHandoff: false });
        return emptyResult();
      }, "sessions_yield"),
      runAbort.signal,
    );
    await expect(wrapped.execute("yield", {})).rejects.toMatchObject(abortError);
  });

  it("does not start sessions_yield when the run was already handed off", async () => {
    const runAbort = new AbortController();
    runAbort.abort(handoffReason);
    const onYield = vi.fn();
    await expect(yieldTool(runAbort, onYield).execute("yield", {})).rejects.toMatchObject(
      abortError,
    );
    expect(onYield).not.toHaveBeenCalled();
  });

  it("preserves an actual sessions_yield failure after its owner starts the handoff", async () => {
    const runAbort = new AbortController();
    const yieldError = new Error("yield bookkeeping failed");
    const wrapped = yieldTool(runAbort, () => {
      runAbort.abort(handoffReason);
      throw yieldError;
    });
    await expect(wrapped.execute("yield", {})).rejects.toBe(yieldError);
  });

  it("does not enter private preparation when the run is already aborted", async () => {
    const source = vi.fn(async () => ({
      kind: "ready" as const,
      args: {},
      execute: vi.fn(async () => emptyResult()),
      dispose: vi.fn(),
    }));
    const runAbort = new AbortController();
    runAbort.abort();
    const wrapped = wrapToolWithAbortSignal(
      attachInternalToolExecutionPreparer(tool(vi.fn()), source),
      runAbort.signal,
    );
    const prepare = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "abort-adapted preparer",
    );
    await expect(prepare({ toolCallId: "aborted", args: {} })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(source).not.toHaveBeenCalled();
  });

  it("disposes cancellation-ignoring private preparation after a later abort", async () => {
    const started = deferred();
    const blocked = deferred();
    const dispose = vi.fn();
    const body = vi.fn(async () => emptyResult());
    const source = vi.fn(async () => {
      started.resolve();
      await blocked.promise;
      return { kind: "ready" as const, args: {}, execute: body, dispose };
    });
    const runAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      attachInternalToolExecutionPreparer(tool(vi.fn()), source),
      runAbort.signal,
    );
    const prepare = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "abort-adapted preparer",
    );
    const preparing = prepare({ toolCallId: "aborted", args: {} });
    await started.promise;
    runAbort.abort();
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    blocked.resolve();
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
  });
});

vi.mock("./channel-tools.js", () => ({
  listChannelAgentTools: () => [
    {
      name: "plugin_login",
      description: "plugin_login stub",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    },
  ],
  copyChannelAgentToolMeta: <T>(value: T) => value,
  getChannelAgentToolMeta: () => undefined,
}));

it("restricts node-originated runs to the node-safe tool subset", () => {
  const names = createOpenClawCodingTools({ messageProvider: "node" }).map((entry) => entry.name);
  expect(names).toContain("canvas");
  for (const name of ["exec", "read", "write", "edit", "message", "sessions_send", "subagents"]) {
    expect(names, name).not.toContain(name);
  }
});

describe("agent ring-zero tool context", () => {
  it("isolates concurrent async runs and clears the scope after settlement", async () => {
    const firstTool = tool(async () => emptyResult(), "first");
    const secondTool = tool(async () => emptyResult(), "second");
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();
    const first = runWithAgentRingZeroTools([firstTool], async () => {
      firstReady.resolve();
      await release.promise;
      return getActiveAgentRingZeroTools();
    });
    const second = runWithAgentRingZeroTools([secondTool], async () => {
      secondReady.resolve();
      await release.promise;
      return getActiveAgentRingZeroTools();
    });
    await Promise.all([firstReady.promise, secondReady.promise]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
    release.resolve();
    expect((await first).map((entry) => entry.name)).toEqual(["first"]);
    expect((await second).map((entry) => entry.name)).toEqual(["second"]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("lets nested normal runs explicitly clear inherited authority", () => {
    runWithAgentRingZeroTools([tool(async () => emptyResult(), "ring-zero")], () => {
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
      runWithAgentRingZeroTools([], () => expect(getActiveAgentRingZeroTools()).toEqual([]));
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
    });
    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("revokes authority from detached callbacks after the run settles", async () => {
    const release = deferred();
    const detachedResult = deferred<readonly AnyAgentTool[]>();
    await runWithAgentRingZeroTools([tool(async () => emptyResult(), "ring-zero")], async () => {
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
      void release.promise.then(() => detachedResult.resolve(getActiveAgentRingZeroTools()));
    });
    expect(getActiveAgentRingZeroTools()).toEqual([]);
    release.resolve();
    expect(await detachedResult.promise).toEqual([]);
  });

  it("revokes retained executable handles after the run settles", async () => {
    const execute = vi.fn(async () => emptyResult());
    let retained: AnyAgentTool | undefined;
    await runWithAgentRingZeroTools([tool(execute, "ring-zero")], async () => {
      retained = getActiveAgentRingZeroTools()[0];
      await retained?.execute("inside", {}, undefined, undefined);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      expectDefined(retained, "retained ring-zero tool").execute("outside", {}),
    ).rejects.toThrow('host-scoped tool "ring-zero" is no longer authorized for this run');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
