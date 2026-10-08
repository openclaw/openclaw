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
type Signals = { attach: (spawned: unknown) => void };

const loadLauncher = () =>
  require(launcherPath) as {
    EXIT_TIMED_OUT: number;
    decodePayload: (argv: string[]) => unknown;
    assertPinnedNativeComponents: (
      env: Record<string, string | undefined>,
      fileExists: (file: string) => boolean,
    ) => { nativeLibraryPath: string; executorPath: string };
    forwardSignals: (options?: {
      exit?: (code: number) => void;
      exitGraceMs?: number;
      onSignal?: (signal: string, handler: () => void) => void;
      setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
    }) => Signals;
    launchSandbox: (
      sdk: {
        spawn: (request: unknown) => Promise<FakeProcess>;
        spawnWithPty: (request: unknown) => Promise<FakeProcess>;
      },
      request: unknown,
      options: { pty?: boolean; debug?: boolean },
      signals: Signals,
      io: Io,
    ) => Promise<number>;
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

const attachOnly: Signals = { attach: () => {} };

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
    expect(() =>
      assertPinnedNativeComponents(env, (file) => file !== nativeLibraryPath),
    ).toThrow(/mxc_ffi\.dll/u);
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

    const result = launchSandbox(
      { spawn, spawnWithPty },
      {},
      { pty: false },
      attachOnly,
      io,
    );
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

    const result = launchSandbox(
      { spawn, spawnWithPty },
      {},
      { pty: true },
      attachOnly,
      io,
    );
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

  it("kills a sandbox that finishes spawning after a forwarded signal", () => {
    const { forwardSignals } = loadLauncher();
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const signals = forwardSignals({
      exit,
      exitGraceMs: 25,
      onSignal: (signal, handler) => handlers.set(signal, handler),
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
    });

    handlers.get("SIGTERM")?.();
    const spawned = { kill: vi.fn() };
    signals.attach(spawned);
    handlers.get("SIGINT")?.();

    expect(spawned.kill).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(25);
    expect(timers[0]?.unref).toHaveBeenCalledTimes(1);
    timers[0]?.callback();
    expect(exit).toHaveBeenCalledWith(143);
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
