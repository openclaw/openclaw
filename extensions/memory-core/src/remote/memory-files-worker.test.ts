import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import { MemoryWatchPolicy } from "../memory/watch-policy.js";
import { serveMemoryFiles } from "./memory-files-worker.js";

it("streams settled file notifications and closes the watcher when its input closes", async () => {
  const state = await createOpenClawTestState({ label: "memory-files-watch" });
  const workspace = state.workspaceDir;
  const input = new PassThrough();
  const output = new PassThrough();
  let events = "";
  output.on("data", (data: Buffer) => {
    events += data.toString("utf8");
  });
  const started = vi.spyOn(MemoryFileWatcher.prototype, "start");
  const closed = vi.spyOn(MemoryFileWatcher.prototype, "close");
  let worker: Promise<void> | undefined;
  try {
    await fs.mkdir(path.join(workspace, "memory"));
    await fs.writeFile(path.join(workspace, "memory", "notes.md"), "before\n");
    worker = serveMemoryFiles({ workspace, input, output, watch: true });
    input.write(
      `${JSON.stringify({ agentId: "main", settings: { extraPaths: [], multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 }, sync: { watchDebounceMs: 10 } } })}\n`,
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await started.mock.results[0]?.value;
    // Consume initial reconciliation before proving a later filesystem edit.
    await vi.waitFor(() => expect(events).toContain('"change"\n'), { timeout: 10_000 });
    // Preserve unavailable diagnostics from the initial reconciliation.
    events = events.replaceAll('"change"\n', "");
    await fs.writeFile(path.join(workspace, "memory", "notes.md"), "after\n");
    await vi.waitFor(() => expect(events).toContain('"change"\n'), { timeout: 10_000 });
    input.end();
    await worker;
    expect(closed).toHaveBeenCalledOnce();
    expect(events).not.toContain("unavailable");
  } finally {
    input.end();
    await worker;
    started.mockRestore();
    closed.mockRestore();
    output.destroy();
    await state.cleanup();
  }
}, 15_000);

it("closes remote watch admission while startup is waiting on a filesystem probe", async () => {
  const state = await createOpenClawTestState({ label: "memory-files-watch" });
  const workspace = state.workspaceDir;
  const input = new PassThrough();
  const output = new PassThrough();
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  const closing = createDeferred<void>();
  // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the intercepted policy receiver via .call.
  const original = MemoryWatchPolicy.prototype.observations;
  let admissionSignal: AbortSignal | undefined;
  const probe = vi
    .spyOn(MemoryWatchPolicy.prototype, "observations")
    .mockImplementation(async function (this: MemoryWatchPolicy, signal) {
      const groups = await original.call(this, signal);
      admissionSignal = signal;
      entered.resolve();
      await resume.promise;
      return groups;
    });
  // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the intercepted watcher owner.
  const originalClose = MemoryFileWatcher.prototype.close;
  const close = vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
    this: MemoryFileWatcher,
  ) {
    closing.resolve();
    return originalClose.call(this);
  });
  let worker: Promise<void> | undefined;
  try {
    await fs.mkdir(path.join(workspace, "memory"));
    worker = serveMemoryFiles({ workspace, input, output, watch: true });
    input.write(
      `${JSON.stringify({ agentId: "main", settings: { extraPaths: [], multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 }, sync: { watchDebounceMs: 10 } } })}\n`,
    );
    await entered.promise;
    input.end();
    await closing.promise;
    expect(admissionSignal?.aborted).toBe(true);
    let joined = false;
    void worker.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    resume.resolve();
    await worker;
    expect(close).toHaveBeenCalledOnce();
    expect(output.read()).toBeNull();
  } finally {
    resume.resolve();
    input.end();
    await worker;
    probe.mockRestore();
    close.mockRestore();
    output.destroy();
    await state.cleanup();
  }
});

it.each(["input end", "output error"] as const)(
  "joins held Memory scans and stdout retirement after %s",
  async (ending) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    vi.stubEnv("CHOKIDAR_INTERVAL", "20");
    const state = await createOpenClawTestState({ label: "memory-watch-stdout" });
    const input = new PassThrough();
    const written = createDeferred<void>();
    const retired = createDeferred<void>();
    const closingStarted = createDeferred<void>();
    const scanEntered = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    let physicalClosed = false;
    void retired.promise.then(() => {
      physicalClosed = true;
    });
    let blocked = true;
    const callbacks: Array<(error?: Error | null) => void> = [];
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        written.resolve();
        if (blocked) {
          callbacks.push(callback);
        } else {
          callback();
        }
      },
    });
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted instance is passed to the real close owner.
    const originalClose = MemoryFileWatcher.prototype.close;
    const close = vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
      this: MemoryFileWatcher,
    ) {
      closingStarted.resolve();
      const pending = originalClose.call(this);
      void pending.then(retired.resolve, retired.reject);
      return pending;
    });
    const worker = serveMemoryFiles({ workspace: state.workspaceDir, input, output, watch: true });
    let finished = false;
    void worker.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      input.write(
        JSON.stringify({
          agentId: "main",
          settings: {
            extraPaths: [],
            multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
            sync: { watchDebounceMs: 10 },
          },
        }) + "\n",
      );
      await written.promise;
      expect(output.writableNeedDrain).toBe(true);
      let held = false;
      __setFsSafeTestHooksForTest({
        async beforeWatchRegistration() {
          if (held) {
            return;
          }
          held = true;
          scanEntered.resolve();
          await releaseScan.promise;
        },
      });
      await scanEntered.promise;
      const failure = new Error("Memory stdout failed");
      if (ending === "output error") {
        output.destroy(failure);
      } else {
        input.end();
      }
      await closingStarted.promise;
      expect(physicalClosed).toBe(false);
      expect(finished).toBe(false);
      __setFsSafeTestHooksForTest();
      releaseScan.resolve();
      await retired.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (ending === "input end") {
        expect(finished).toBe(false);
        blocked = false;
        callbacks.splice(0).forEach((callback) => callback());
        await worker;
        expect(output.writableLength).toBe(0);
      } else {
        await expect(worker).rejects.toMatchObject({ errors: [failure] });
      }
      expect(close).toHaveBeenCalledOnce();
    } finally {
      __setFsSafeTestHooksForTest();
      releaseScan.resolve();
      blocked = false;
      callbacks.splice(0).forEach((callback) => callback());
      input.end();
      await worker.catch(() => {});
      close.mockRestore();
      output.destroy();
      await state.cleanup();
      vi.unstubAllEnvs();
    }
  },
);
