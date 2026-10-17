import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as messageDecoder from "./app-server/client-message-decoder.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexServerNotification, CodexThread } from "./app-server/protocol.js";
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

function createClientHarness(options?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(options);
  disposers.push(() => harness.client.closeAndWait());
  return harness;
}

async function observe(
  options: CodexAppServerStartOptions,
  ...clients: ReturnType<typeof createHarness>[]
) {
  for (const { client } of clients) {
    await observeCodexCatalogClient(client, { startOptions: options });
  }
}

async function subscribe(
  options: CodexAppServerStartOptions,
  listener: Parameters<typeof subscribeCodexCatalogEvents>[1] = () => {},
  callbacks?: Parameters<typeof subscribeCodexCatalogEvents>[2],
) {
  const stop = subscribeCodexCatalogEvents(
    await codexCatalogResidentHomeKey({ startOptions: options }),
    listener,
    callbacks,
  );
  disposers.push(stop);
  return stop;
}

function startOptions(home = tempDirs.make("codex-catalog-events-")): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    homeScope: "user",
    command: "codex",
    args: ["app-server"],
    headers: {},
    env: { CODEX_HOME: home },
  };
}

function remoteOptions(
  options: CodexAppServerStartOptions,
  name: string,
): CodexAppServerStartOptions {
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

describe("Codex catalog events", () => {
  it("publishes ephemeral thread/fork acknowledgements before resolving the request", async () => {
    const options = startOptions();
    const excluded = vi.fn();
    const otherHome = vi.fn();
    const stop = await subscribe(options, undefined, { onEphemeralThread: excluded });
    disposers.push(
      subscribeCodexCatalogEvents("unrelated-home", () => {}, { onEphemeralThread: otherHome }),
    );
    let ephemeral = true;
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        send({ id: request.id, result: { thread: { id: "helper-thread", ephemeral } } });
      },
    });
    await observe(options, harness);

    await expect(harness.client.request("thread/fork", {})).resolves.toEqual({
      thread: { id: "helper-thread", ephemeral: true },
    });
    expect(excluded).toHaveBeenCalledExactlyOnceWith("helper-thread");
    expect(otherHome).not.toHaveBeenCalled();

    ephemeral = false;
    await harness.client.request("thread/fork", {});
    expect(excluded).toHaveBeenCalledOnce();
    stop();
    ephemeral = true;
    await harness.client.request("thread/fork", {});
    expect(excluded).toHaveBeenCalledOnce();
  });

  it.each(["onClose", "onRemoteReady"] as const)(
    "reports %s once per client until unsubscribe",
    async (callback) => {
      const options = startOptions();
      const isRemote = callback === "onRemoteReady";
      const target = isRemote ? remoteOptions(options, "ready") : options;
      const received = vi.fn();
      const localReady = vi.fn();
      const stop = await subscribe(target, undefined, { [callback]: received });
      await subscribe(options, undefined, { onRemoteReady: localReady });
      const local = createClientHarness();
      const first = createClientHarness();
      const replacement = createClientHarness();
      const unsubscribed = createClientHarness();
      await observe(options, local);
      await observe(target, first, first);
      if (!isRemote) {
        expect(received).not.toHaveBeenCalled();
        first.client.close();
        first.client.close();
      }
      expect(received).toHaveBeenCalledOnce();
      expect(localReady).not.toHaveBeenCalled();
      if (isRemote) {
        first.client.close();
        await observe(target, replacement, replacement);
        expect(received).toHaveBeenCalledTimes(2);
      }
      stop();
      await observe(target, unsubscribed);
      unsubscribed.client.close();
      expect(received).toHaveBeenCalledTimes(isRemote ? 2 : 1);
      expect([local, first, replacement, unsubscribed].flatMap(({ writes }) => writes)).toEqual([]);
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
    const options = startOptions();
    const harness = createClientHarness();
    const receive = vi.fn();
    const otherHome = vi.fn();
    const stop = await subscribe(options, receive);
    disposers.push(subscribeCodexCatalogEvents("unrelated-home", otherHome));
    await observe(options, harness, harness);
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
    expect(receive.mock.calls.map(([event]) => event)).toEqual(events);
    expect(otherHome).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
    stop();
    harness.send(events[0]);
    expect(receive).toHaveBeenCalledTimes(events.length);
  });

  it("reads only the requested thread metadata when a catalog listener needs it", async () => {
    const options = startOptions();
    const thread = {
      id: "thread-1",
      name: "Updated title",
      preview: "x".repeat(40 * 1024),
      extra: { discarded: "native payload ".repeat(4_096) },
    };
    const harness = createClientHarness();
    let reading: Promise<CodexThread> | undefined;
    await subscribe(options, (_event, readThread) => {
      reading = readThread(thread.id);
    });
    await observe(options, harness);
    expect(harness.writes).toEqual([]);
    harness.send({ method: "turn/completed", params: { threadId: thread.id, turn: {} } });
    const request = JSON.parse(await harness.waitForWrite(0));
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: thread.id, includeTurns: false },
    });
    const parse = vi.spyOn(messageDecoder, "parseCodexAppServerMessage");
    harness.send({ id: request.id, result: { thread } });
    await expect(reading).resolves.toEqual({
      id: thread.id,
      name: thread.name,
      projectId: null,
      preview: "x".repeat(500),
    });
    expect(parse).not.toHaveBeenCalled();
    expect(harness.writes).toHaveLength(1);
  });
});
