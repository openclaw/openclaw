import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions as StartOptions } from "./app-server/config-contracts.js";
import type { CodexServerNotification } from "./app-server/protocol.js";
import {
  createClientHarness as createHarness,
  useAutoCleanupTempDirTracker,
} from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import { codexCatalogHomeIdFromCanonicalPath } from "./session-catalog-home-id.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const disposers: Array<() => void | Promise<void>> = [];

function callbacks() {
  return { onClose: vi.fn(), onRemoteReady: vi.fn(), onEphemeralThread: vi.fn() };
}

async function fixture(options = startOptions()) {
  const receive = vi.fn();
  const lifecycle = callbacks();
  const foreign = { ...callbacks(), receive: vi.fn() };
  const key = await codexCatalogResidentHomeKey({ startOptions: options });
  const stop = subscribeCodexCatalogEvents(key, receive, lifecycle);
  disposers.push(stop, subscribeCodexCatalogEvents("unrelated-home", foreign.receive, foreign));
  const clients: ReturnType<typeof createHarness>[] = [];
  return {
    options,
    receive,
    foreign,
    stop,
    ...lifecycle,
    writes: () => clients.flatMap(({ writes }) => writes),
    async client(repeat = 1, params?: Parameters<typeof createHarness>[0]) {
      const harness = createHarness(params);
      clients.push(harness);
      disposers.push(async () => {
        await harness.client.closeAndWait();
      });
      for (let i = 0; i < repeat; i++) {
        await observeCodexCatalogClient(harness.client, { startOptions: options });
      }
      return harness;
    },
  };
}

function startOptions(home = tempDirs.make("codex-catalog-events-")): StartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    headers: {},
    env: { CODEX_HOME: home },
  };
}

function remoteOptions(options: StartOptions, name: string): StartOptions {
  return {
    ...options,
    transport: "websocket",
    url: `wss://${name}.example.test/codex`,
    authToken: `synthetic-${name}-credential`,
  };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
  vi.restoreAllMocks();
});

it("publishes ephemeral thread/fork acknowledgements before resolving the request", async () => {
  const catalog = await fixture();
  let ephemeral = true;
  const harness = await catalog.client(1, {
    onWrite(line, send) {
      const request = JSON.parse(line);
      send({ id: request.id, result: { thread: { id: "helper-thread", ephemeral } } });
    },
  });

  await expect(harness.client.request("thread/fork", {})).resolves.toEqual({
    thread: { id: "helper-thread", ephemeral: true },
  });
  expect(catalog.onEphemeralThread).toHaveBeenCalledExactlyOnceWith("helper-thread");
  expect(catalog.foreign.onEphemeralThread).not.toHaveBeenCalled();

  ephemeral = false;
  await harness.client.request("thread/fork", {});
  expect(catalog.onEphemeralThread).toHaveBeenCalledOnce();
  catalog.stop();
  ephemeral = true;
  await harness.client.request("thread/fork", {});
  expect(catalog.onEphemeralThread).toHaveBeenCalledOnce();
});

it.each(["onClose", "onRemoteReady"] as const)(
  "reports %s once per client until unsubscribe",
  async (callback) => {
    const isRemote = callback === "onRemoteReady";
    const local = await fixture();
    const target = isRemote ? await fixture(remoteOptions(local.options, "ready")) : local;
    const received = target[callback];
    if (isRemote) {
      await local.client();
    }
    const first = await target.client(2);
    if (!isRemote) {
      expect(received).not.toHaveBeenCalled();
      first.client.close();
      first.client.close();
    }
    expect(received).toHaveBeenCalledOnce();
    expect(local.onRemoteReady).not.toHaveBeenCalled();
    if (isRemote) {
      first.client.close();
      await target.client(2);
      expect(received).toHaveBeenCalledTimes(2);
    }
    target.stop();
    const unsubscribed = await target.client();
    unsubscribed.client.close();
    expect(received).toHaveBeenCalledTimes(isRemote ? 2 : 1);
    expect([...local.writes(), ...target.writes()]).toEqual([]);
  },
);

it("shares canonical local homes and keeps remote endpoints and credentials separate", async () => {
  const directory = tempDirs.make("codex-catalog-events-");
  const home = path.join(directory, "home");
  const alias = path.join(directory, "alias");
  await fs.mkdir(home);
  await fs.symlink(home, alias, "dir");
  const options = startOptions(home);
  const localKey = await codexCatalogResidentHomeKey({ startOptions: options });
  expect(localKey).toBe(codexCatalogHomeIdFromCanonicalPath(await fs.realpath(home)));
  await expect(codexCatalogResidentHomeKey({ startOptions: startOptions(alias) })).resolves.toBe(
    localKey,
  );
  const remote = remoteOptions(options, "first");
  const remoteKey = await codexCatalogResidentHomeKey({
    startOptions: remote,
    sourceHomeId: localKey,
  });
  expect(remoteKey).not.toBe(localKey);
  for (const overrides of [
    { url: "wss://second.example.test/codex" },
    { authToken: "synthetic-second-credential" },
  ]) {
    await expect(
      codexCatalogResidentHomeKey({ startOptions: { ...remote, ...overrides } }),
    ).resolves.not.toBe(remoteKey);
  }
});

it("forwards catalog lifecycle changes once without performing a native request", async () => {
  const catalog = await fixture();
  const harness = await catalog.client(2);
  const events: CodexServerNotification[] = [
    { method: "thread/started", params: { thread: { id: "thread-1" } } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    ...["archived", "deleted", "unarchived", "reverted"].map((action) => ({
      method: `thread/${action}`,
      params: { threadId: "thread-1" },
    })),
    { method: "thread/name/updated", params: { threadId: "thread-1", threadName: "New title" } },
    { method: "thread/status/changed", params: { threadId: "thread-1", status: "idle" } },
  ];
  for (const event of events) {
    harness.send(event);
  }
  harness.send({ method: "item/agentMessage/delta", params: { delta: "streaming text" } });
  expect(catalog.receive.mock.calls.map(([event]) => event)).toEqual(events);
  expect(catalog.foreign.receive).not.toHaveBeenCalled();
  expect(harness.writes).toEqual([]);
  catalog.stop();
  harness.send(events[0]);
  expect(catalog.receive).toHaveBeenCalledTimes(events.length);
});
