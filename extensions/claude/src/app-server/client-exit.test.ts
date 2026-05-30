import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spawn mock so we can drive a fake bridge child without a real process.
// Partial mock — other modules in the import graph use execFile/etc., so keep
// the real exports and override only spawn.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { ClaudeAppServerClient } from "./client.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ClaudeAppServerClient child-exit handling", () => {
  let child: FakeChild;

  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  async function startInitializedClient(): Promise<ClaudeAppServerClient> {
    const client = new ClaudeAppServerClient({ command: "fake-bridge", commandSource: "config" });
    const startP = client.start();
    await flush();
    // Respond to the initialize request (id 1) with a supported version so the
    // version-floor assertion passes and start() resolves.
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.2.11" } } })}\n`,
    );
    await startP;
    return client;
  }

  it("fires onExit and rejects in-flight requests when the child exits", async () => {
    const client = await startInitializedClient();

    const seen: Error[] = [];
    client.onExit((err) => seen.push(err));

    const pending = client.request("turn/start", { threadId: "t1" }).catch((err: unknown) => err);
    child.emit("exit", 1, null);

    const rejected = await pending;
    expect(rejected).toBeInstanceOf(Error);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toMatch(/exited/);
  });

  it("onExit disposer prevents the listener from firing", async () => {
    const client = await startInitializedClient();
    const seen: Error[] = [];
    const dispose = client.onExit((err) => seen.push(err));
    dispose();
    child.emit("exit", 0, "SIGTERM");
    await flush();
    expect(seen).toHaveLength(0);
  });
});
