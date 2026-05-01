import EventEmitter from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

function createFakeChildProcess() {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn().mockReturnValue(true);
  stdin.end = vi.fn();

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as ReturnType<typeof spawnMock> & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn();
  return child;
}

describe("IMessageRpcClient — stdin error handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects pending requests and does not emit uncaughtException when stdin emits EPIPE", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");

    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);

    const { createIMessageRpcClient } = await import("./client.js");
    const client = await createIMessageRpcClient({ cliPath: "/fake/imsg" });

    const requestPromise = client.request("ping").catch((err: Error) => err);

    // Simulate EPIPE on stdin (child closed its read end)
    const epipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    child.stdin.emit("error", epipeError);

    const result = await requestPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/EPIPE/i);
  });
});
