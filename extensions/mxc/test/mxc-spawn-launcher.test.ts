import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/mxc-spawn-launcher.mjs",
);

type WaitResult = { exitCode: number; timedOut: boolean };
type FakeProcess = {
  standardInput?: Writable | null;
  standardOutput?: Readable | null;
  standardError?: Readable | null;
  input?: Writable;
  output?: Readable;
  warnings?: string[];
  wait: () => Promise<WaitResult>;
  kill: () => void;
};
type Io = { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
type Signals = {
  attach: (spawned: unknown) => void;
  signaled: () => boolean;
  exitCode: () => number | undefined;
  dispose: () => void;
};
type FakeTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const loadLauncher = () =>
  require(launcherPath) as {
    EXIT_TIMED_OUT: number;
    decodePayload: (argv: string[]) => unknown;
    assertPinnedNativeComponents: (
      env: Record<string, string | undefined>,
      fileExists: (file: string) => boolean,
    ) => { nativeLibraryPath: string; executorPath: string };
    forwardSignals: (options?: {
      exitGraceMs?: number;
      onSignal?: (signal: string, handler: () => void) => void;
      offSignal?: (signal: string, handler: () => void) => void;
      setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
      clearTimeout?: (timer: unknown) => void;
    }) => Signals;
    launchSandbox: (
      sdk: {
        spawn: (request: unknown) => Promise<FakeProcess>;
        spawnWithPty: (request: unknown) => Promise<FakeProcess>;
      },
      request: unknown,
      options: { pty?: boolean; debug?: boolean },
      signals: Signals | undefined,
      io: Io,
      timers?: FakeTimers,
    ) => Promise<number>;
    PTY_EXECUTOR_BACKSTOP_MS: number;
    signalExitCode: (signal: number | string | undefined) => number;
  };

function createIo(): Io & { read: (stream: PassThrough) => string } {
  const chunks = new Map<PassThrough, Buffer[]>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  for (const stream of [stdout, stderr]) {
    chunks.set(stream, []);
    stream.on("data", (chunk: Buffer) => chunks.get(stream)?.push(chunk));
  }
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    read: (stream) => Buffer.concat(chunks.get(stream) ?? []).toString("utf8"),
  };
}

function endedStream(text: string): PassThrough {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

const attachOnly: Signals = {
  attach: () => {},
  signaled: () => false,
  exitCode: () => undefined,
  dispose: () => {},
};

function createTimers() {
  const pending: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const timers: FakeTimers = {
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  };
  return { timers, pending };
}

// A PTY sandbox whose wait() settles only when the test (or a kill) finishes it.
function createPtyProcess() {
  let finish: (result: WaitResult) => void = () => {};
  const output = new PassThrough();
  const kill = vi.fn();
  const spawned: FakeProcess = {
    input: new PassThrough(),
    output,
    wait: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    kill,
  };
  return {
    spawned,
    kill,
    finish: (result: WaitResult) => {
      output.end();
      finish(result);
    },
  };
}

async function startPtyLaunch(request: { timeoutMs?: number }, signals: Signals = attachOnly) {
  const { launchSandbox } = loadLauncher();
  const io = createIo();
  const { timers, pending } = createTimers();
  const { spawned, kill, finish } = createPtyProcess();
  const spawnWithPty = vi.fn(async (_request: unknown) => spawned);
  const result = launchSandbox(
    { spawn: vi.fn(), spawnWithPty },
    request,
    { pty: true },
    signals,
    io,
    timers,
  );
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  return { result, io, pending, kill, finish, spawnWithPty };
}

describe("mxc-spawn-launcher", () => {
  it("decodes a JSON --payload-file and removes it before spawning", () => {
    const { decodePayload } = loadLauncher();
    const dir = mkdtempSync(path.join(tmpdir(), "mxc-launcher-test-"));
    const payloadFile = path.join(dir, "payload.json");
    const body = { request: { environment: { SECRET: "value" } }, options: { pty: false } };
    try {
      writeFileSync(payloadFile, JSON.stringify(body), "utf-8");

      expect(decodePayload(["--payload-file", payloadFile])).toEqual(body);
      expect(existsSync(payloadFile)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("rejects missing payload arguments and payloads without a request", () => {
    const { decodePayload } = loadLauncher();
    const dir = mkdtempSync(path.join(tmpdir(), "mxc-launcher-test-"));
    const payloadFile = path.join(dir, "payload.json");
    try {
      writeFileSync(payloadFile, JSON.stringify({ config: {}, options: {} }), "utf-8");

      expect(() => decodePayload([])).toThrow(/Missing --payload-file/);
      expect(() => decodePayload(["--payload-file", payloadFile])).toThrow(/container request/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("fails closed when a pinned native component is missing", () => {
    const { assertPinnedNativeComponents } = loadLauncher();
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const env = { MXC_BIN_DIR: "C:\\mxc", MXC_FFI_DIR: path.join("C:\\mxc", arch) };
    const nativeLibraryPath = path.join(env.MXC_FFI_DIR, "mxc_ffi.dll");
    const executorPath = path.join(env.MXC_BIN_DIR, arch, "wxc-exec.exe");

    expect(assertPinnedNativeComponents(env, () => true)).toEqual({
      nativeLibraryPath,
      executorPath,
    });
    expect(() => assertPinnedNativeComponents(env, (file) => file !== nativeLibraryPath)).toThrow(
      /mxc_ffi\.dll/u,
    );
    expect(() => assertPinnedNativeComponents(env, (file) => file !== executorPath)).toThrow(
      /wxc-exec\.exe/u,
    );
    expect(() => assertPinnedNativeComponents({ MXC_BIN_DIR: "C:\\mxc" }, () => true)).toThrow(
      /MXC_FFI_DIR/u,
    );
  });

  it("bridges piped stdio and reports the sandbox exit code", async () => {
    const { launchSandbox } = loadLauncher();
    const io = createIo();
    const standardInput = new PassThrough();
    const received: Buffer[] = [];
    standardInput.on("data", (chunk: Buffer) => received.push(chunk));
    const inputEnded = new Promise((resolve) => standardInput.once("finish", resolve));
    const spawned: FakeProcess = {
      standardInput,
      standardOutput: endedStream("out"),
      standardError: endedStream("err"),
      wait: async () => {
        await inputEnded;
        return { exitCode: 7, timedOut: false };
      },
      kill: vi.fn(),
    };
    const spawn = vi.fn(async () => spawned);
    const spawnWithPty = vi.fn();

    const result = launchSandbox({ spawn, spawnWithPty }, {}, { pty: false }, attachOnly, io);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    io.stdin.end("input");

    await expect(result).resolves.toBe(7);
    expect(spawnWithPty).not.toHaveBeenCalled();
    expect(Buffer.concat(received).toString()).toBe("input");
    expect(io.read(io.stdout)).toBe("out");
    expect(io.read(io.stderr)).toBe("err");
  });

  it("bridges PTY output and sends EOF as Ctrl-D", async () => {
    const { launchSandbox } = loadLauncher();
    const io = createIo();
    const input = new PassThrough();
    const received: Buffer[] = [];
    input.on("data", (chunk: Buffer) => received.push(chunk));
    const sawEof = new Promise<void>((resolve) =>
      input.on("data", (chunk: Buffer) => chunk.includes("\x04") && resolve()),
    );
    const spawned: FakeProcess = {
      input,
      output: endedStream("terminal"),
      wait: async () => {
        await sawEof;
        return { exitCode: 0, timedOut: false };
      },
      kill: vi.fn(),
    };
    const spawnWithPty = vi.fn(async () => spawned);
    const spawn = vi.fn();

    const result = launchSandbox({ spawn, spawnWithPty }, {}, { pty: true }, attachOnly, io);
    await vi.waitFor(() => expect(spawnWithPty).toHaveBeenCalled());
    io.stdin.end("dir\r");

    await expect(result).resolves.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(Buffer.concat(received).toString()).toBe("dir\r\x04");
    expect(io.read(io.stdout)).toBe("terminal");
  });

  it("exits 124 with a stderr notice when the sandbox times out", async () => {
    const { launchSandbox, EXIT_TIMED_OUT } = loadLauncher();
    const io = createIo();
    const spawned: FakeProcess = {
      standardInput: null,
      standardOutput: endedStream(""),
      standardError: endedStream(""),
      wait: async () => ({ exitCode: 1, timedOut: true }),
      kill: vi.fn(),
    };

    const code = await launchSandbox(
      { spawn: async () => spawned, spawnWithPty: vi.fn() },
      {},
      {},
      attachOnly,
      io,
    );

    expect(EXIT_TIMED_OUT).toBe(124);
    expect(code).toBe(124);
    expect(io.read(io.stderr)).toMatch(/timed out/u);
  });

  it("kills a running PTY sandbox at its deadline and reports 124", async () => {
    const { PTY_EXECUTOR_BACKSTOP_MS } = loadLauncher();
    const { result, io, pending, kill, finish, spawnWithPty } = await startPtyLaunch({
      timeoutMs: 30_000,
    });

    expect(pending[0]?.ms).toBe(30_000);
    expect(spawnWithPty.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 30_000 + PTY_EXECUTOR_BACKSTOP_MS,
    });
    pending[0]?.callback();
    expect(kill).toHaveBeenCalledTimes(1);
    // node-pty reports the executor's killed or timed-out status as -1, never timedOut.
    finish({ exitCode: -1, timedOut: false });

    await expect(result).resolves.toBe(124);
    expect(io.read(io.stderr)).toMatch(/timed out/u);
  });

  it("reports a PTY exit of -1 before the deadline as the command status", async () => {
    const { result, io, pending, kill, finish } = await startPtyLaunch({ timeoutMs: 30_000 });

    finish({ exitCode: -1, timedOut: false });

    await expect(result).resolves.toBe(-1);
    expect(pending[0]?.cleared).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(io.read(io.stderr)).toBe("");
  });

  it("ignores a PTY deadline that fires after completion was observed", async () => {
    const { result, io, pending, kill, finish } = await startPtyLaunch({ timeoutMs: 30_000 });

    finish({ exitCode: 3, timedOut: false });
    await expect(result).resolves.toBe(3);
    pending[0]?.callback();

    expect(kill).not.toHaveBeenCalled();
    expect(io.read(io.stderr)).toBe("");
  });

  it("does not report a timeout after a signal cancelled the PTY sandbox", async () => {
    const forced: { code?: number } = {};
    const signals: Signals = {
      attach: () => {},
      signaled: () => true,
      exitCode: () => forced.code,
      dispose: () => {},
    };
    const { result, io, pending, kill, finish } = await startPtyLaunch(
      { timeoutMs: 30_000 },
      signals,
    );

    pending[0]?.callback();
    expect(kill).not.toHaveBeenCalled();
    forced.code = 143;
    finish({ exitCode: -1, timedOut: false });

    await expect(result).resolves.toBe(143);
    expect(io.read(io.stderr)).toBe("");
  });

  it("keeps the forced signal status when a signal follows the PTY deadline", async () => {
    const forced: { code?: number } = {};
    const signals: Signals = {
      attach: () => {},
      signaled: () => false,
      exitCode: () => forced.code,
      dispose: () => {},
    };
    const { result, pending, finish } = await startPtyLaunch({ timeoutMs: 30_000 }, signals);

    pending[0]?.callback();
    forced.code = 130;
    finish({ exitCode: -1, timedOut: false });

    await expect(result).resolves.toBe(130);
  });

  it("leaves requests without a PTY deadline unchanged", async () => {
    const { launchSandbox } = loadLauncher();
    const { timers, pending } = createTimers();
    const request = { timeoutMs: 30_000 };
    const spawned: FakeProcess = {
      standardInput: null,
      standardOutput: endedStream(""),
      standardError: endedStream(""),
      wait: async () => ({ exitCode: -1, timedOut: false }),
      kill: vi.fn(),
    };
    const spawn = vi.fn(async (_request: unknown) => spawned);

    await expect(
      launchSandbox({ spawn, spawnWithPty: vi.fn() }, request, {}, attachOnly, createIo(), timers),
    ).resolves.toBe(-1);
    expect(spawn.mock.calls[0]?.[0]).toBe(request);
    expect(pending).toHaveLength(0);
  });

  it("kills a sandbox that finishes spawning after a forwarded signal without exiting", () => {
    const { forwardSignals } = loadLauncher();
    const handlers = new Map<string, () => void>();
    const clearTimeoutMock = vi.fn();
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const signals = forwardSignals({
      exitGraceMs: 25,
      onSignal: (signal, handler) => handlers.set(signal, handler),
      offSignal: (signal, handler) => {
        if (handlers.get(signal) === handler) {
          handlers.delete(signal);
        }
      },
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearTimeout: clearTimeoutMock,
    });

    handlers.get("SIGTERM")?.();
    expect(signals.signaled()).toBe(true);
    const spawned = { kill: vi.fn() };
    signals.attach(spawned);
    handlers.get("SIGINT")?.();

    expect(spawned.kill).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(25);
    expect(timers[0]?.unref).toHaveBeenCalledTimes(1);
    expect(signals.exitCode()).toBeUndefined();
    timers[0]?.callback();
    expect(spawned.kill).toHaveBeenCalledTimes(3);
    expect(signals.exitCode()).toBe(143);
    signals.dispose();
    expect(clearTimeoutMock).toHaveBeenCalledWith(timers[0]);
    expect(handlers.size).toBe(0);
  });

  it("releases launcher input and signal listeners once the sandbox completes", async () => {
    const { launchSandbox } = loadLauncher();
    const io = createIo();
    const signalListeners = process.listeners("SIGTERM");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced launcher exit");
    });
    const standardInput = new PassThrough();
    let finish: (result: WaitResult) => void = () => {};
    const spawned: FakeProcess = {
      standardInput,
      standardOutput: endedStream(""),
      standardError: endedStream(""),
      wait: () => new Promise((resolve) => (finish = resolve)),
      kill: vi.fn(),
    };
    try {
      const result = launchSandbox(
        { spawn: async () => spawned, spawnWithPty: vi.fn() },
        {},
        {},
        undefined,
        io,
      );
      await vi.waitFor(() => expect(io.stdin.listenerCount("data")).toBe(1));
      expect(process.listeners("SIGTERM")).toHaveLength(signalListeners.length + 1);
      finish({ exitCode: 7, timedOut: false });

      await expect(result).resolves.toBe(7);
      expect(exit).not.toHaveBeenCalled();
      expect(io.stdin.listenerCount("data")).toBe(0);
      expect(io.stdin.listenerCount("end")).toBe(0);
      expect(standardInput.destroyed).toBe(true);
      expect(process.listeners("SIGTERM")).toEqual(signalListeners);
    } finally {
      exit.mockRestore();
    }
  });

  it("maps signal exits to process exit codes", () => {
    const { signalExitCode } = loadLauncher();

    expect(signalExitCode(15)).toBe(143);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGUNKNOWN")).toBe(1);
    expect(signalExitCode(undefined)).toBe(1);
  });
});
