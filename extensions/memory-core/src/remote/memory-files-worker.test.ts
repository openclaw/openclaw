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
function start(output: Writable) {
  const input = new PassThrough();
  const worker = serveMemoryFiles({
    workspace: fixture.state.workspaceDir,
    input,
    output,
    watch: true,
  });
  const finished = vi.fn();
  void worker.then(finished, finished);
  fixture.cleanup(async () => {
    input.end();
    await worker.catch(() => {});
    output.destroy();
  });
  return { input, worker, finished };
}
function observeClose() {
  const closing = createDeferred<{ retired: Promise<void> }>();
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
  const original = MemoryFileWatcher.prototype.close;
  vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
    this: MemoryFileWatcher,
  ) {
    const retired = original.call(this);
    closing.resolve({ retired });
    return retired;
  });
  return closing.promise;
}
const requestLine = JSON.stringify(request) + "\n";

it("revokes remote admission while startup is awaiting filesystem discovery", async () => {
  const output = new PassThrough();
  const entered = createDeferred<AbortSignal>();
  const resume = fixture.barrier();
  const closing = observeClose();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted owner.
  const original = MemoryWatchPolicy.prototype.observations;
  vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementation(async function (
    this: MemoryWatchPolicy,
    signal,
  ) {
    const groups = await original.call(this, signal);
    entered.resolve(signal);
    await resume.promise;
    return groups;
  });
  const { input, worker, finished } = start(output);
  input.write(requestLine);
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

it.each(["input end", "output error"] as const)(
  "joins observation and backpressured stdout after %s",
  async (ending) => {
    const ready = createDeferred<void>();
    const written = createDeferred<void>();
    const physical = fixture.barrier();
    const drain = fixture.barrier();
    const closing = observeClose();
    observer.created = () => ready.resolve();
    observer.closeBarrier = physical.promise;
    let events = "";
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        events += chunk.toString("utf8");
        written.resolve();
        void drain.promise.then(() => callback());
      },
    });
    const { input, worker, finished } = start(output);
    input.write(requestLine);
    await ready.promise;
    observer.observations[0]!.dirty();
    expect(events).toBe("");
    await vi.advanceTimersByTimeAsync(10);
    await written.promise;
    expect(events).toBe('"change"\n');
    expect(output.writableNeedDrain).toBe(true);
    const failure = new Error("Memory stdout failed");
    if (ending === "output error") {
      output.destroy(failure);
    } else {
      input.end();
    }
    const { retired } = await closing;
    expect(finished).not.toHaveBeenCalled();
    physical.resolve();
    await retired;
    if (ending === "input end") {
      expect(finished).not.toHaveBeenCalled();
      drain.resolve();
      await worker;
      expect(output.writableLength).toBe(0);
    } else {
      await expect(worker).rejects.toMatchObject({ errors: [failure] });
    }
    expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
  },
);

it("preserves the malformed diary error code across the remote file protocol", async () => {
  const dreamsPath = path.join(fixture.state.workspaceDir, "DREAMS.md");
  const bytes = Buffer.concat([Buffer.from("# Dream Diary\n"), Buffer.from([0xff])]);
  await fs.writeFile(dreamsPath, bytes);
  const input = new PassThrough();
  const output = new PassThrough();
  const worker = serveMemoryFiles({ workspace: fixture.state.workspaceDir, input, output });
  fixture.cleanup(async () => {
    input.end();
    await worker;
    output.destroy();
  });
  input.end(JSON.stringify({ operation: "maintenance", method: "readDreams", args: [dreamsPath] }));
  await worker;

  expect(JSON.parse(String(output.read()))).toMatchObject({
    error: { code: "ERR_INVALID_UTF8", message: expect.stringContaining("must be valid UTF-8") },
  });
  expect(await fs.readFile(dreamsPath)).toEqual(bytes);
});
