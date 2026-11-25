import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import { MemoryWatchPolicy } from "../memory/watch-policy.js";
import { serveMemoryFiles } from "./memory-files-worker.js";
import { memoryWatchFixture, request } from "./memory-worker.test-support.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("../memory/watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));
const fixture = memoryWatchFixture(() => observer.reset(), "memory-files-watch");
function start<T extends Writable>(output: T, watch = true) {
  const input = new PassThrough();
  const worker = serveMemoryFiles({ workspace: fixture.state.workspaceDir, input, output, watch });
  const finished = vi.fn();
  void worker.then(finished, finished);
  fixture.cleanup(async () => {
    input.end();
    await worker.catch(() => {});
    output.destroy();
  });
  if (watch) {
    input.write(JSON.stringify(request) + "\n");
  }
  return { input, output, worker, finished };
}
function observeClose() {
  const closing = createDeferred<{ retired: Promise<void> }>();
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
  const original = MemoryFileWatcher.prototype.close;
  const close = vi.spyOn(MemoryFileWatcher.prototype, "close");
  close.mockImplementation(function (this: MemoryFileWatcher) {
    const retired = original.call(this);
    closing.resolve({ retired });
    return retired;
  });
  return closing.promise;
}
it("revokes remote admission while startup is awaiting filesystem discovery", async () => {
  const entered = createDeferred<AbortSignal>();
  const resume = fixture.barrier();
  const closing = observeClose();
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
  const original = MemoryWatchPolicy.prototype.observations;
  const observations = vi.spyOn(MemoryWatchPolicy.prototype, "observations");
  observations.mockImplementation(async function (this: MemoryWatchPolicy, signal) {
    const groups = await original.call(this, signal);
    entered.resolve(signal);
    await resume.promise;
    return groups;
  });
  const { input, output, worker, finished } = start(new PassThrough());
  const admissionSignal = await entered.promise;
  input.end();
  await closing;
  expect(admissionSignal.aborted).toBe(true);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  resume.resolve();
  await worker;
  expect(observer.watch).not.toHaveBeenCalled();
  expect(output.read()).toBeNull();
});

it.each(["end", "error"])("joins watcher and backpressured stdout on %s", async (ending) => {
  const ready = createDeferred<void>();
  const written = createDeferred<Buffer>();
  const physical = fixture.barrier();
  const drain = fixture.barrier();
  const closing = observeClose();
  observer.created = () => ready.resolve();
  observer.closeBarrier = physical.promise;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      written.resolve(chunk);
      void drain.promise.then(() => callback());
    },
  });
  const { input, worker, finished } = start(output);
  await ready.promise;
  observer.observations[0]!.dirty();
  expect(output.writableLength).toBe(0);
  await vi.advanceTimersByTimeAsync(10);
  expect((await written.promise).toString("utf8")).toBe('"change"\n');
  expect(output.writableNeedDrain).toBe(true);
  const failure = new Error("Memory stdout failed");
  if (ending === "error") {
    output.destroy(failure);
  } else {
    input.end();
  }
  const { retired } = await closing;
  expect(finished).not.toHaveBeenCalled();
  physical.resolve();
  await retired;
  if (ending === "end") {
    expect(finished).not.toHaveBeenCalled();
    drain.resolve();
    await worker;
    expect(output.writableLength).toBe(0);
  } else {
    await expect(worker).rejects.toMatchObject({ errors: [failure] });
  }
});

it("preserves the malformed diary error code across the remote file protocol", async () => {
  const dreamsPath = path.join(fixture.state.workspaceDir, "DREAMS.md");
  await fs.writeFile(dreamsPath, Buffer.from([0xff]));
  const { input, output, worker } = start(new PassThrough(), false);
  input.end(JSON.stringify({ operation: "maintenance", method: "readDreams", args: [dreamsPath] }));
  await worker;
  expect(JSON.parse(String(output.read())).error.code).toBe("ERR_INVALID_UTF8");
});
