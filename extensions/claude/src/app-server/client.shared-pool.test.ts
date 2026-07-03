import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spawn mock so we can drive fake bridge children without real
// processes. Partial mock — other modules in the import graph use
// execFile/etc., so keep the real exports and override only spawn.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import type { ClaudeAppServerClient } from "./client.js";
import {
  clearSharedClaudeAppServerClient,
  getSharedClaudeAppServerClient,
  peekSharedClaudeAppServerClient,
} from "./client.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

let nextFakePid = 9000;

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = nextFakePid++;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Real-runtime regression test for openclaw-7ss: the shared client cache
 * must be a keyed pool, not a single slot, so two harness extensions with
 * different spawn env (e.g. real Anthropic vs Z.ai) can run concurrently
 * without tearing each other's process down. Drives the real
 * getSharedClaudeAppServerClient/clearSharedClaudeAppServerClient/
 * peekSharedClaudeAppServerClient — no mocking of the pool logic itself,
 * only the child_process boundary.
 */
describe("shared claude app-server client pool (openclaw-7ss)", () => {
  let children: FakeChild[] = [];

  beforeEach(() => {
    children = [];
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    await clearSharedClaudeAppServerClient();
    spawnMock.mockReset();
  });

  // Calls client.start() (which synchronously calls spawn() and pushes the
  // fake child onto `children`), THEN looks up the just-spawned child, THEN
  // writes its initialize response, THEN awaits start(). Looking the child
  // up only AFTER start() runs (not as a pre-evaluated argument) avoids a
  // JS argument-evaluation-order trap: `children[n]` read before start() is
  // called would still be `undefined`, since spawn() only happens inside
  // start(), not at client construction time.
  async function startAndInitialize(client: ClaudeAppServerClient): Promise<FakeChild> {
    const startP = client.start();
    await flush();
    const child = children[children.length - 1];
    if (!child) {
      throw new Error("expected spawn() to have pushed a fake child by now");
    }
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.2.17" } } })}\n`,
    );
    await startP;
    return child;
  }

  it("returns the same client for the same spawn options (no re-spawn)", async () => {
    const opts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const clientA = getSharedClaudeAppServerClient(opts);
    await startAndInitialize(clientA);
    await clientA.start(); // already initialized; must resolve immediately

    const clientB = getSharedClaudeAppServerClient(opts);
    expect(clientB).toBe(clientA);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("spawns a SECOND independent client for different env WITHOUT stopping the first (the core fix)", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = {
      command: "fake-bridge",
      env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "zai-key" },
    };

    const anthropicClient = getSharedClaudeAppServerClient(anthropicOpts);
    const anthropicChild = await startAndInitialize(anthropicClient);

    const zaiClient = getSharedClaudeAppServerClient(zaiOpts);
    await startAndInitialize(zaiClient);

    // Two distinct clients, two distinct spawned children.
    expect(zaiClient).not.toBe(anthropicClient);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // The critical regression check: spawning the second (GLM/Z.ai) client
    // must NOT have torn down the first (Anthropic) child process. Before
    // the fix, getSharedClaudeAppServerClient would call .stop() on the old
    // single-slot client whenever the key changed.
    expect(anthropicChild.stdin.destroyed).toBe(false);
    expect(anthropicClient.isRunning()).toBe(true);
    expect(zaiClient.isRunning()).toBe(true);

    // Re-requesting the anthropic client by its original options still
    // returns the SAME still-running instance — it was never touched.
    const anthropicAgain = getSharedClaudeAppServerClient(anthropicOpts);
    expect(anthropicAgain).toBe(anthropicClient);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("peek reflects the most recently accessed pool entry", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    expect(peekSharedClaudeAppServerClient()).toBeNull();

    const anthropicClient = getSharedClaudeAppServerClient(anthropicOpts);
    await startAndInitialize(anthropicClient);
    expect(peekSharedClaudeAppServerClient()?.running).toBe(true);

    const zaiClient = getSharedClaudeAppServerClient(zaiOpts);
    await startAndInitialize(zaiClient);
    expect(peekSharedClaudeAppServerClient()?.running).toBe(true);
  });

  it("clearSharedClaudeAppServerClient stops every pool entry, not just one", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    const anthropicClient = getSharedClaudeAppServerClient(anthropicOpts);
    const anthropicChild = await startAndInitialize(anthropicClient);

    const zaiClient = getSharedClaudeAppServerClient(zaiOpts);
    const zaiChild = await startAndInitialize(zaiClient);

    await clearSharedClaudeAppServerClient();

    expect(anthropicChild.stdin.destroyed).toBe(true);
    expect(zaiChild.stdin.destroyed).toBe(true);
    expect(peekSharedClaudeAppServerClient()).toBeNull();
  });
});
