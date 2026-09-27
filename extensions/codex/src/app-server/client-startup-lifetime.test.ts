import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
  resolveCodexNativeConfigFenceKey,
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
  return harness;
}

function acquire() {
  return getLeasedSharedCodexAppServerClient({
    startOptions,
    authProfileId: null,
    timeoutMs: 1_000,
  });
}

beforeEach(async () => {
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

describe("guarded startup request lifetime", () => {
  it.each(["thread/start", "thread/resume", "thread/fork"])(
    "%s timeout preserves a peer and releases its fence on the exact late response",
    async (method) => {
      const old = createHarness();
      const replacement = createHarness();
      vi.spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(old.client)
        .mockResolvedValueOnce(replacement.client);
      expect(await acquire()).toBe(old.client);
      const peer = old.client.request("turn/start", { threadId: "peer" }, { timeoutMs: 5_000 });
      const peerFrame = await waitForHarnessRequest(old, "turn/start");
      let continued = false;
      const startup = old.client
        .request(method, { threadId: "abandoned" }, { timeoutMs: 100 })
        .then(
          () => {
            continued = true;
          },
          (error: unknown) => error,
        );
      const frame = await waitForHarnessRequest(old, method);
      expect(await startup).toMatchObject({ reason: "timed out", mayHaveWritten: true });
      expect(old.stdinDestroyed).toBe(false);
      expect(await acquire()).toBe(replacement.client);

      // A replacement's same-home startup must not overtake the old native work.
      const blocked = replacement.client.request("thread/start", {}, { timeoutMs: 100 });
      await expect(blocked).rejects.toMatchObject({ reason: "timed out", mayHaveWritten: false });
      expect(replacement.writes.some((line) => JSON.parse(line).method === "thread/start")).toBe(
        false,
      );
      expect(replacement.stdinDestroyed).toBe(false);

      old.send({ id: frame.id, result: { thread: { id: "abandoned" } } });
      old.send({ method: "thread/started", params: { thread: { id: "abandoned" } } });
      const helperStartIndex = old.writes.length;
      const helper = old.client.request("thread/fork", { threadId: "peer" }, { timeoutMs: 1_000 });
      const helperFrame = await waitForHarnessRequest(old, "thread/fork", helperStartIndex);
      old.send({ id: helperFrame.id, result: { thread: { id: "peer-helper" } } });
      await expect(helper).resolves.toEqual({ thread: { id: "peer-helper" } });
      expect(continued).toBe(false);
      old.send({ id: peerFrame.id, result: { turn: { id: "peer-turn" } } });
      await expect(peer).resolves.toEqual({ turn: { id: "peer-turn" } });
      expect(old.stdinDestroyed).toBe(false);

      expect(releaseLeasedSharedCodexAppServerClient(old.client)).toBe(true);
      expect(old.stdinDestroyed).toBe(true);
      old.emitExit();
      retireSharedCodexAppServerClientIfCurrent(old.client);
      expect(await acquire()).toBe(replacement.client);
      expect(replacement.stdinDestroyed).toBe(false);
      expect(
        replacement.writes.some((line) => JSON.parse(line).method === "thread/unsubscribe"),
      ).toBe(false);
      releaseLeasedSharedCodexAppServerClient(replacement.client);
      releaseLeasedSharedCodexAppServerClient(replacement.client);
    },
  );

  it.each(["response", "rpc error", "overload", "exit"])(
    "an aborted written startup holds config until %s, without rechecking stale ownership",
    async (settlement) => {
      const harness = createHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      await acquire();
      const controller = new AbortController();
      const assertCurrent = vi.fn();
      const startup = harness.client
        .request(
          "thread/resume",
          { threadId: "abandoned" },
          {
            signal: controller.signal,
            assertCurrent,
          },
        )
        .catch((error: unknown) => error);
      const frame = await waitForHarnessRequest(harness, "thread/resume");
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
      const { acquireCodexNativeConfigFence } = await import("./native-config-fence.js");
      const release = await acquireCodexNativeConfigFence(
        resolveCodexNativeConfigFenceKey({ client: harness.client })!,
        { timeoutMs: 1_000 },
      );
      release();
      expect(assertCurrent).toHaveBeenCalledTimes(calls);
      expect(
        harness.writes.filter((line) => JSON.parse(line).method === "thread/resume"),
      ).toHaveLength(1);
      releaseLeasedSharedCodexAppServerClient(harness.client);
    },
  );
  it("keeps a pending claimant through retirement and cannot retire its replacement", async () => {
    const old = createHarness();
    const replacement = createHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(old.client)
      .mockResolvedValueOnce(replacement.client);
    await acquire();
    const controller = new AbortController();
    const startup = old.client
      .request("thread/start", {}, { signal: controller.signal })
      .catch((error: unknown) => error);
    const frame = await waitForHarnessRequest(old, "thread/start");
    const pendingAcquire = getLeasedSharedCodexAppServerClient({
      startOptions,
      authProfileId: null,
      timeoutMs: 1_000,
      onStartedClient: () => controller.abort(),
    });
    expect(await startup).toMatchObject({ reason: "aborted", mayHaveWritten: true });
    expect(await pendingAcquire).toBe(old.client);
    expect(await acquire()).toBe(replacement.client);
    releaseLeasedSharedCodexAppServerClient(old.client);
    expect(old.stdinDestroyed).toBe(false);
    old.send({ id: frame.id, result: { thread: { id: "abandoned" } } });
    releaseLeasedSharedCodexAppServerClient(old.client);
    expect(old.stdinDestroyed).toBe(true);
    old.emitExit();
    retireSharedCodexAppServerClientIfCurrent(old.client);
    expect(await acquire()).toBe(replacement.client);
    expect(replacement.stdinDestroyed).toBe(false);
    releaseLeasedSharedCodexAppServerClient(replacement.client);
    releaseLeasedSharedCodexAppServerClient(replacement.client);
  });

  it("logical transport closure cannot release an unconfirmed native config fence", async () => {
    const harness = createHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    await acquire();
    const startup = harness.client
      .request("thread/start", {}, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    await waitForHarnessRequest(harness, "thread/start");
    expect(await startup).toMatchObject({ reason: "timed out" });
    const { acquireCodexNativeConfigFence } = await import("./native-config-fence.js");
    const key = resolveCodexNativeConfigFenceKey({ client: harness.client })!;
    harness.client.close();
    await expect(acquireCodexNativeConfigFence(key, { timeoutMs: 100 })).rejects.toThrow(
      "timed out",
    );
    harness.emitExit();
    const release = await acquireCodexNativeConfigFence(key, { timeoutMs: 1_000 });
    release();
    releaseLeasedSharedCodexAppServerClient(harness.client);
  });
  it("preserves confirmed overload rejection when the response beats an expired timer", async () => {
    const harness = createHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    await acquire();
    const startup = harness.client
      .request("thread/start", {}, { timeoutMs: 1_000 })
      .catch((error: unknown) => error);
    const frame = await waitForHarnessRequest(harness, "thread/start");
    // Advance elapsed time past the deadline without running the timer callback.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2_000);
    harness.send({ id: frame.id, error: { code: -32001, message: "Server overloaded" } });
    expect(await startup).toMatchObject({ reason: "timed out", mayHaveWritten: false });
    now.mockRestore();
    expect(await acquire()).toBe(harness.client);
    expect(harness.stdinDestroyed).toBe(false);
    expect(
      harness.writes.filter((line) => JSON.parse(line).method === "thread/start"),
    ).toHaveLength(1);
    releaseLeasedSharedCodexAppServerClient(harness.client);
    releaseLeasedSharedCodexAppServerClient(harness.client);
  });
});
