import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import type * as Store from "./manager/store.js";
const { sleepMock, historyMock } = vi.hoisted(() => ({ sleepMock: vi.fn(), historyMock: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: sleepMock }));
vi.mock("./manager/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  getCallHistoryFromStore: historyMock,
}));
import { registerVoiceCallLogs } from "./cli-call-log.js";
let workspace: Awaited<ReturnType<typeof tempWorkspace>>;
let file: string;
let output: Buffer[];
let stdout: MockInstance<typeof process.stdout.write>;
let previousExitCode: typeof process.exitCode;
const stopped = new Error("diagnostic test finished");
beforeEach(async () => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "voice-call-log-",
  });
  file = await workspace.write("diagnostics.jsonl", "");
  output = [];
  sleepMock.mockReset().mockRejectedValue(stopped);
  historyMock.mockReset().mockResolvedValue([]);
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
});
afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  await workspace.cleanup();
});
function command(...args: string[]) {
  const program = new Command();
  registerVoiceCallLogs({ root: program, defaultFile: file, ensureHistoryStateRuntime() {} });
  return program.parseAsync(args, { from: "user" });
}
function capture(chunk: unknown) {
  output.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
  return true;
}
const text = () => Buffer.concat(output).toString("utf8");

it("summarizes retained megabyte records without reading the whole file", async () => {
  const records = [120, 240, 360].map((latency) =>
    JSON.stringify({ metadata: { lastTurnLatencyMs: latency }, padding: "x".repeat(600_000) }),
  );
  fs.writeFileSync(file, `${records.join("\n")}\n`);
  const readFile = vi.spyOn(fs, "readFileSync");
  await command("latency", "--last", "3");
  expect(JSON.parse(text())).toMatchObject({
    recordsScanned: 3,
    turnLatency: { count: 3, avgMs: 240, minMs: 120, maxMs: 360 },
  });
  expect(readFile.mock.calls.filter(([target]) => target === file)).toEqual([]);
});

it.skipIf(process.platform === "win32").each(["latency", "tail"])(
  "rejects a FIFO for %s without waiting for a writer",
  async (subcommand) => {
    const fifo = path.join(workspace.dir, "diagnostics.pipe");
    execFileSync("mkfifo", [fifo]);
    const writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    try {
      await expect(command(subcommand, "--file", fifo)).rejects.toThrow(
        "Voice-call log must be a regular file.",
      );
    } finally {
      fs.closeSync(writer);
    }
  },
);

it.each(["replace", "SIGINT", "SIGTERM"] as const)(
  "settles a pending JSONL record on %s",
  async (mode) => {
    const listeners = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    fs.writeFileSync(file, '{"seq":0}\n{"retired":');
    const replacement = `${JSON.stringify({ seq: 1, text: "fresh".repeat(64) })}\n`;
    sleepMock.mockImplementationOnce(async (_ms, _value, options?: { signal?: AbortSignal }) => {
      if (mode === "replace") {
        fs.renameSync(await workspace.write("replacement.jsonl", replacement), file);
      } else {
        process.emit(mode);
        process.emit(mode === "SIGINT" ? "SIGTERM" : "SIGINT");
        options?.signal?.throwIfAborted();
      }
    });
    const result = await command("tail", "--since", "1").catch((error: unknown) => error);
    expect(result).toEqual(mode === "replace" ? stopped : expect.any(Command));
    expect(process.exitCode).toBe(mode === "replace" ? undefined : mode === "SIGINT" ? 130 : 143);
    expect(text()).toBe(`{"seq":0}\n${mode === "replace" ? replacement : ""}`);
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(listeners);
  },
);

it.each(["drain", "error"] as const)(
  "settles blocked stdout on %s and closes its descriptor",
  async (event) => {
    fs.writeFileSync(file, event === "error" ? '{"seq":0}\n' : '{"seq":0}\n{"seq":1}\n');
    const drainListeners = process.stdout.listenerCount("drain");
    const blocked = createDeferred<void>();
    const failed = new Error("output pipe failed");
    let writable = false;
    stdout.mockImplementation((chunk) => {
      capture(chunk);
      blocked.resolve();
      return writable;
    });
    const open = vi.spyOn(fs, "openSync");
    const running = command("tail", "--since", "2").catch((error: unknown) => error);
    await blocked.promise;
    const opened = open.mock.results[open.mock.calls.findIndex(([target]) => target === file)];
    assert(opened?.type === "return", "diagnostic command did not open its log");
    const fd = opened.value;
    const close = vi.spyOn(fs, "closeSync");
    try {
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      expect(text()).not.toContain('"seq":1');
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      writable = true;
      process.stdout.emit(event, failed);
      expect(await running).toBe(event === "error" ? failed : stopped);
    }
    expect(close).toHaveBeenCalledExactlyOnceWith(fd);
    expect(process.stdout.listenerCount("drain")).toBe(drainListeners);
    expect(sleepMock).toHaveBeenCalledTimes(event === "error" ? 0 : 1);
    expect(text()).toBe(event === "error" ? '{"seq":0}' : '{"seq":0}\n{"seq":1}\n');
  },
);

it("streams partial large UTF-8 records across polls", async () => {
  const bytes = Buffer.from(JSON.stringify({ text: "é".repeat(700_000) }));
  fs.writeFileSync(file, bytes.subarray(0, 600_001));
  sleepMock.mockImplementationOnce(async () => {
    fs.appendFileSync(file, Buffer.concat([bytes.subarray(600_001), Buffer.from("\n")]));
  });
  const read = vi.spyOn(fs, "readSync");
  await expect(command("tail", "--since", "0")).rejects.toBe(stopped);
  assert.deepStrictEqual(Buffer.concat(output), Buffer.concat([bytes, Buffer.from("\n")]));
  expect(read.mock.calls.every(([, buffer]) => buffer.byteLength <= 64 * 1024)).toBe(true);
});

it.each([
  ["newline", "first\nsecond\n", 6, undefined],
  ["mid-record", '{"event":"first"}\n{"event":"second"}\n', 13, undefined],
  [
    "copy-truncated",
    '{"event":"staleé-with-more-observed-bytes"}\n',
    Buffer.byteLength('{"event":"stale', "utf8") + 1,
    '{"event":"fresh-start-full"}\n',
  ],
] as const)("buffers short reads: %s", async (_name, appended, bytes, replacement) => {
  const initial = "initial\n";
  const initialByteLength = Buffer.byteLength(initial);
  fs.writeFileSync(file, initial);
  const read = fs.readSync.bind(fs);
  let shortened = false;
  vi.spyOn(fs, "readSync").mockImplementation(((fd, buffer, offset, length, position) => {
    if (!shortened && position === initialByteLength && Buffer.isBuffer(buffer)) {
      shortened = true;
      return read(fd, buffer, offset, bytes, position);
    }
    return read(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  sleepMock
    .mockImplementationOnce(async () => fs.appendFileSync(file, appended))
    .mockImplementationOnce(async () => {
      if (replacement !== undefined) {
        fs.writeFileSync(file, replacement);
      }
    });
  await expect(command("tail", "--since", "0", "--poll", "50")).rejects.toBe(stopped);
  expect(shortened).toBe(true);
  expect(text()).toEqual(replacement ?? expect.stringContaining(appended));
  expect(text()).not.toContain('{"event":"fir\n');
});

it("keeps latency selection, envelopes, malformed JSON and final EOF semantics", async () => {
  fs.writeFileSync(
    file,
    [
      '{"metadata":{"lastTurnLatencyMs":900}}',
      "",
      '{"call":{"metadata":{"lastTurnLatencyMs":100,"lastTurnListenWaitMs":20}}}',
      "invalid JSON",
      "null",
      '{"metadata":{"lastTurnLatencyMs":300,"lastTurnLatencyMs":200}}',
    ].join("\n"),
  );
  await command("latency", "--last", "4");
  expect(JSON.parse(text())).toMatchObject({
    recordsScanned: 2,
    turnLatency: { count: 2, minMs: 100, maxMs: 200, avgMs: 150 },
    listenWait: { count: 1, avgMs: 20 },
  });
});

it.each(["snapshots", "SIGINT", "SIGTERM", "read"] as const)(
  "settles retained history: %s",
  async (mode) => {
    const listeners = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    file = path.join(workspace.dir, "calls.jsonl");
    const first = { callId: "first", state: "completed" },
      second = { callId: "second", state: "completed" };
    const reading = createDeferred<void>(),
      release = createDeferred<void>();
    if (mode === "read") {
      historyMock.mockImplementationOnce(async () => {
        reading.resolve();
        await release.promise;
        return [first];
      });
    } else {
      for (const snapshot of [[first], [first, second], [second], [first], [first]]) {
        historyMock.mockResolvedValueOnce(snapshot);
      }
      if (mode !== "snapshots") {
        sleepMock.mockImplementation(async (_ms, _value, options?: { signal?: AbortSignal }) => {
          process.emit(mode);
          process.emit(mode === "SIGINT" ? "SIGTERM" : "SIGINT");
          options?.signal?.throwIfAborted();
        });
      }
      for (let poll = 0; poll < 3; poll++) {
        sleepMock.mockResolvedValueOnce(undefined);
      }
    }
    const running = command("tail", "--since", "1").catch((error: unknown) => error);
    try {
      if (mode === "read") {
        await reading.promise;
        process.emit("SIGINT");
        release.resolve();
      }
      const result = await running;
      expect(result).toEqual(mode === "snapshots" ? stopped : expect.any(Command));
      expect(process.exitCode).toBe(
        mode === "snapshots" ? undefined : mode === "SIGTERM" ? 143 : 130,
      );
      const lines = text().trim().split("\n").filter(Boolean);
      expect(lines.map((line) => JSON.parse(line))).toEqual(
        mode === "read" ? [] : [first, second, first],
      );
      expect(sleepMock).toHaveBeenCalledTimes(mode === "read" ? 0 : 4);
    } finally {
      release.resolve();
      await running;
    }
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(listeners);
  },
);
