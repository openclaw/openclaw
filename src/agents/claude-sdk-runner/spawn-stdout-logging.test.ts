import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeSdkSpawnWithStdoutTailLogging,
  defaultClaudeSdkSpawnProcess,
} from "./spawn-stdout-logging.js";

type FakeSpawnedProcess = SpawnedProcess & {
  pushStdout: (text: string) => void;
  emitExit: (code: number | null) => void;
};

function createFakeSpawnedProcess(): FakeSpawnedProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  let exitCode: number | null = null;

  return {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    kill(signal: NodeJS.Signals): boolean {
      killed = true;
      emitter.emit("exit", null, signal);
      return true;
    },
    on(event, listener): void {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    once(event, listener): void {
      emitter.once(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener): void {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
    pushStdout(text: string): void {
      stdout.write(text);
    },
    emitExit(code: number | null): void {
      exitCode = code;
      emitter.emit("exit", code, null);
    },
  };
}

describe("createClaudeSdkSpawnWithStdoutTailLogging", () => {
  it("captures stdout tail and reports it on exit code 1", () => {
    const fakeProcess = createFakeSpawnedProcess();
    const baseSpawn = vi.fn(() => fakeProcess as SpawnedProcess);
    const onExitCodeOne = vi.fn();
    const wrappedSpawn = createClaudeSdkSpawnWithStdoutTailLogging({
      baseSpawn,
      maxTailChars: 8,
      onExitCodeOne,
    });

    wrappedSpawn({
      command: "claude",
      args: ["--version"],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
    });

    fakeProcess.pushStdout("abcdef");
    fakeProcess.pushStdout("ghijkl");
    fakeProcess.emitExit(1);

    expect(baseSpawn).toHaveBeenCalledOnce();
    expect(onExitCodeOne).toHaveBeenCalledWith("efghijkl");
  });

  it("does not report stdout tail on successful exit", () => {
    const fakeProcess = createFakeSpawnedProcess();
    const onExitCodeOne = vi.fn();
    const wrappedSpawn = createClaudeSdkSpawnWithStdoutTailLogging({
      baseSpawn: () => fakeProcess as SpawnedProcess,
      onExitCodeOne,
    });

    wrappedSpawn({
      command: "claude",
      args: ["--version"],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
    });

    fakeProcess.pushStdout("hello");
    fakeProcess.emitExit(0);

    expect(onExitCodeOne).not.toHaveBeenCalled();
  });
});

describe("defaultClaudeSdkSpawnProcess", () => {
  it("pipes stderr so SDK stderr callbacks can capture diagnostics", async () => {
    const stderrChunks: string[] = [];
    const proc = defaultClaudeSdkSpawnProcess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('stderr-ready')"],
      cwd: process.cwd(),
      env: process.env,
      signal: new AbortController().signal,
    });
    const procWithStderr = proc as unknown as {
      stderr?: NodeJS.ReadableStream | null;
      once: SpawnedProcess["once"];
    };

    expect(procWithStderr.stderr).toBeTruthy();
    procWithStderr.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    await new Promise<void>((resolve, reject) => {
      proc.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`unexpected exit code: ${String(code)}`));
      });
    });

    expect(stderrChunks.join("")).toContain("stderr-ready");
  });
});
