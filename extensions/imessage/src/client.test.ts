// Imessage tests cover the RPC client child-process stream error handling.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// A dead imsg helper can emit an async `error` on any of its stdio streams. On
// a raw EventEmitter an unhandled `error` throws synchronously, which in the
// real gateway surfaces as an uncaughtException and crashes the process (#75438
// covered stdin only). The mock child mirrors that stdio shape so we can assert
// each stream's `error` is caught and routed to failAll.
type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: (line: string, cb?: (err?: Error | null) => void) => boolean;
    end: () => void;
  };
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as MockChild["stdin"];
  // Resolve every write cleanly so the pending request only settles via the
  // stream error path under test.
  stdin.write = (_line, cb) => {
    cb?.(null);
    return true;
  };
  stdin.end = () => {};
  child.stdin = stdin;
  child.kill = vi.fn();
  return child;
}

describe("IMessageRpcClient child stream error handling", () => {
  let child: MockChild;

  beforeEach(() => {
    // start() refuses to spawn under a test env; clear the markers so the real
    // spawn/listener wiring runs against the mock child.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(["stdout", "stderr", "stdin"] as const)(
    "catches a %s stream error and rejects in-flight requests instead of crashing",
    async (streamName) => {
      const { IMessageRpcClient } = await import("./client.js");
      const client = new IMessageRpcClient({ cliPath: "imsg" });
      await client.start();

      const pending = client.request("ping", {}, { timeoutMs: 0 });
      // Keep the rejection from surfacing as an unhandled rejection before we
      // assert on it.
      pending.catch(() => {});

      const streamError = new Error(`${streamName} broke`);
      expect(() => child[streamName].emit("error", streamError)).not.toThrow();

      await expect(pending).rejects.toThrow(`${streamName} broke`);

      await client.stop();
    },
  );
});
