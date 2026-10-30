// Signal daemon lifecycle tests.
import { describe, expect, it, vi } from "vitest";
import { createSignalDaemonLifecycle } from "./daemon-lifecycle.js";

function makeMockDaemonHandle(exitValue?: {
  source: "process" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
}) {
  let resolveExit!: (value: {
    source: "process" | "spawn-error";
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    source: "process" | "spawn-error";
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    exited,
    resolveExit,
    isExited: () => false,
    stop: vi.fn(() => Promise.resolve()),
  };
}

describe("createSignalDaemonLifecycle", () => {
  it("aborts the monitor when the daemon exits unexpectedly", async () => {
    const lifecycle = createSignalDaemonLifecycle({});
    const handle = makeMockDaemonHandle();
    lifecycle.attach(handle);

    handle.resolveExit({
      source: "process",
      code: null,
      signal: "SIGKILL",
    });
    await Promise.resolve();

    expect(lifecycle.getExitError()).toBeDefined();
    expect(lifecycle.abortSignal.aborted).toBe(true);
  });

  it("does not abort the monitor when shutdown has already started", async () => {
    const shutdownController = new AbortController();
    const lifecycle = createSignalDaemonLifecycle({
      shutdownSignal: shutdownController.signal,
    });
    const handle = makeMockDaemonHandle();
    lifecycle.attach(handle);

    shutdownController.abort(new Error("gateway draining"));
    handle.resolveExit({
      source: "process",
      code: null,
      signal: "SIGKILL",
    });
    await Promise.resolve();

    expect(lifecycle.getExitError()).toBeUndefined();
    expect(lifecycle.abortSignal.aborted).toBe(false);
  });

  it("treats the abortSignal as an implicit shutdown signal", async () => {
    const abortController = new AbortController();
    const lifecycle = createSignalDaemonLifecycle({
      abortSignal: abortController.signal,
    });
    const handle = makeMockDaemonHandle();
    lifecycle.attach(handle);

    abortController.abort(new Error("account stopped"));
    handle.resolveExit({
      source: "process",
      code: null,
      signal: "SIGKILL",
    });
    await Promise.resolve();

    expect(lifecycle.getExitError()).toBeUndefined();
  });
});
