import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const harnesses: ReturnType<typeof createClientHarness>[] = [];
let home: string;
let startOptions: CodexAppServerStartOptions;

function createHarness() {
  const harness = createClientHarness({
    autoEmitExit: false,
    onWrite(line, send) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "initialize") {
        send({ id: request.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
      }
    },
  });
  harnesses.push(harness);
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
  return Object.assign(harness, {
    pending: (...args: Parameters<typeof harness.client.request>) =>
      harness.client.request(...args).catch((error: unknown) => error),
    release: () => releaseLeasedSharedCodexAppServerClient(harness.client),
    retire: () => retireSharedCodexAppServerClientIfCurrent(harness.client),
    frame: (method: string, start = 0) => waitForHarnessRequest(harness, method, start),
    count: (method: string) =>
      harness.writes.filter((line) => JSON.parse(line).method === method).length,
  });
}

function acquire(onStartedClient?: () => void) {
  return getLeasedSharedCodexAppServerClient({
    startOptions,
    authProfileId: null,
    timeoutMs: 1_000,
    onStartedClient,
  });
}

beforeEach(async () => {
  vi.spyOn(CodexAppServerClient, "start");
  home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-lifetime-"));
  startOptions = {
    transport: "stdio",
    homeScope: "user",
    command: "codex",
    commandSource: "config",
    args: ["app-server"],
    headers: {},
    env: { CODEX_HOME: home },
  };
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.emitExit();
  }
  await clearSharedCodexAppServerClientAndWait();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

it("fork timeout preserves a peer through the exact late response", async () => {
  const method = "thread/fork";
  const old = createHarness();
  expect(await acquire()).toBe(old.client);
  const peer = old.client.request("turn/start", { threadId: "peer" }, { timeoutMs: 5_000 });
  const peerFrame = await old.frame("turn/start");
  const startup = old.pending(method, { threadId: "abandoned" }, { timeoutMs: 100 });
  const frame = await old.frame(method);
  expect(await startup).toMatchObject({ reason: "timed out", mayHaveWritten: true });
  expect(old.stdinDestroyed).toBe(false);

  old.send({ id: frame.id, result: { thread: { id: "abandoned" } } });
  old.send({ method: "thread/started", params: { thread: { id: "abandoned" } } });
  const helperStartIndex = old.writes.length;
  const helper = old.client.request("thread/fork", { threadId: "peer" }, { timeoutMs: 1_000 });
  const helperFrame = await old.frame("thread/fork", helperStartIndex);
  old.send({ id: helperFrame.id, result: { thread: { id: "peer-helper" } } });
  await expect(helper).resolves.toEqual({ thread: { id: "peer-helper" } });
  old.send({ id: peerFrame.id, result: { turn: { id: "peer-turn" } } });
  await expect(peer).resolves.toEqual({ turn: { id: "peer-turn" } });
  expect(old.stdinDestroyed).toBe(false);

  old.retire();
  expect(old.release()).toBe(true);
  expect(old.stdinDestroyed).toBe(true);
  old.emitExit();
});

it.each(["response", "rpc error", "overload", "exit"])(
  "an aborted written startup settles on %s without rechecking stale ownership",
  async (settlement) => {
    const harness = createHarness();
    await acquire();
    const controller = new AbortController();
    const assertCurrent = vi.fn();
    const startup = harness.pending(
      "thread/resume",
      { threadId: "abandoned" },
      { signal: controller.signal, assertCurrent },
    );
    const frame = await harness.frame("thread/resume");
    controller.abort();
    expect(await startup).toMatchObject({ reason: "aborted", mayHaveWritten: true });
    assertCurrent.mockImplementation(() => {
      throw new Error("successor owns the thread");
    });
    const calls = assertCurrent.mock.calls.length;
    expect(harness.stdinDestroyed).toBe(false);
    if (settlement === "exit") {
      harness.emitExit();
    } else if (settlement === "response") {
      harness.send({ id: frame.id, result: { thread: { id: "abandoned" } } });
    } else {
      harness.send({
        id: frame.id,
        error: { code: settlement === "overload" ? -32001 : -32600, message: "rejected" },
      });
    }
    expect(assertCurrent).toHaveBeenCalledTimes(calls);
    expect(harness.count("thread/resume")).toBe(1);
    harness.release();
  },
);
it("keeps a pending claimant through retirement and cannot retire its replacement", async () => {
  const old = createHarness();
  const replacement = createHarness();
  await acquire();
  const controller = new AbortController();
  const startup = old.pending("thread/start", {}, { signal: controller.signal });
  const frame = await old.frame("thread/start");
  const pendingAcquire = acquire(() => controller.abort());
  expect(await startup).toMatchObject({ reason: "aborted", mayHaveWritten: true });
  expect(await pendingAcquire).toBe(old.client);
  old.retire();
  expect(await acquire()).toBe(replacement.client);
  old.release();
  expect(old.stdinDestroyed).toBe(false);
  old.send({ id: frame.id, result: { thread: { id: "abandoned" } } });
  old.release();
  expect(old.stdinDestroyed).toBe(true);
  old.emitExit();
  old.retire();
  expect(await acquire()).toBe(replacement.client);
  expect(replacement.stdinDestroyed).toBe(false);
  replacement.release();
  replacement.release();
});

it("preserves confirmed overload rejection when the response beats an expired timer", async () => {
  const harness = createHarness();
  await acquire();
  const startup = harness.pending("thread/start", {}, { timeoutMs: 1_000 });
  const frame = await harness.frame("thread/start");
  // Advance elapsed time past the deadline without running the timer callback.
  const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2_000);
  harness.send({ id: frame.id, error: { code: -32001, message: "Server overloaded" } });
  expect(await startup).toMatchObject({ reason: "timed out", mayHaveWritten: false });
  now.mockRestore();
  expect(await acquire()).toBe(harness.client);
  expect(harness.stdinDestroyed).toBe(false);
  expect(harness.count("thread/start")).toBe(1);
  harness.release();
  harness.release();
});
