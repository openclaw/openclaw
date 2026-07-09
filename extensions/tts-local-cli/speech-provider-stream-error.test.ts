// Regression coverage for stdout/stderr stream error handling in the CLI TTS provider.
// Uses a mocked spawn to emit controlled stream errors — the existing test file
// exercises the provider through real child processes.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: vi.fn(),
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

type MockChild = EventEmitter & {
  killed: boolean;
  pid: number;
  stdout: EventEmitter & { destroy: (err?: Error) => void };
  stderr: EventEmitter & { destroy: (err?: Error) => void };
  stdin: EventEmitter & { end: () => void; write: (data: string) => void };
  kill: (signal?: string) => boolean;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.killed = false;
  child.pid = 1234;
  const stdout = new EventEmitter() as EventEmitter & { destroy: (err?: Error) => void };
  stdout.destroy = () => {};
  child.stdout = stdout;
  const stderr = new EventEmitter() as EventEmitter & { destroy: (err?: Error) => void };
  stderr.destroy = () => {};
  child.stderr = stderr;
  const stdin = new EventEmitter() as EventEmitter & { end: () => void; write: () => void };
  stdin.end = () => {};
  stdin.write = () => {};
  child.stdin = stdin;
  child.kill = (signal?: string) => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("CLI TTS provider stream error handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects on stdout stream error instead of silently returning truncated audio", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValue(child);

    const promise = buildCliSpeechProvider().synthesize({
      text: "hello",
      cfg: {} as any,
      providerConfig: {
        command: "/fake/tts",
        args: ["--out", "{{OutputPath}}"],
        timeoutMs: 5000,
      },
      providerOverrides: {},
      timeoutMs: 5000,
      target: "audio-file",
    });

    // synthesize does async work (tempWorkspace) before calling runCli/spawn.
    // Wait until spawn has been called and listeners are attached.
    await vi.waitUntil(() => spawnMock.mock.calls.length > 0, { timeout: 2000 });

    // Simulate stdout pipe breaking mid-generation — the critical scenario:
    // without the fix, this error is unhandled and crashes the process.
    // With the fix, the provider rejects cleanly.
    child.stdout.emit("error", new Error("EPIPE: audio stream broken"));

    await expect(promise).rejects.toThrow("CLI TTS stdout stream error");
    expect(child.killed).toBe(true);
  });

  it("does not crash on stderr stream error", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValue(child);

    const promise = buildCliSpeechProvider().synthesize({
      text: "hello",
      cfg: {} as any,
      providerConfig: {
        command: "/fake/tts",
        args: ["--out", "{{OutputPath}}"],
        timeoutMs: 5000,
      },
      providerOverrides: {},
      timeoutMs: 5000,
      target: "audio-file",
    });

    await vi.waitUntil(() => spawnMock.mock.calls.length > 0, { timeout: 2000 });

    // stderr errors must not throw — diagnostic stream failures are benign
    expect(() => child.stderr.emit("error", new Error("EPIPE: diag broken"))).not.toThrow();

    // Clean up: resolve the promise to avoid unhandled rejection
    child.emit("close", 0);
    await promise.catch(() => {});
  });
});
