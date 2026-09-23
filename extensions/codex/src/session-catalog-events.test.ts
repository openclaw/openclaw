import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerMessageDecoder } from "./app-server/client-message-decoder.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexServerNotification, CodexThread } from "./app-server/protocol.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import { codexCatalogHomeIdFromCanonicalPath } from "./session-catalog-home-id.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const disposers: Array<() => void | Promise<void>> = [];

function startOptions(home: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    homeScope: "user",
    command: "codex",
    args: ["app-server"],
    headers: {},
    env: { CODEX_HOME: home },
  };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
  vi.restoreAllMocks();
});

describe("Codex catalog events", () => {
  it.each(["thread/start", "thread/fork", "thread/resume", "thread/read"] as const)(
    "publishes ephemeral %s acknowledgements before resolving the request",
    async (method) => {
      const options = startOptions(tempDirs.make("codex-catalog-ephemeral-ack-"));
      const excluded = vi.fn();
      const otherHome = vi.fn();
      const stop = subscribeCodexCatalogEvents(
        await codexCatalogResidentHomeKey({ startOptions: options }),
        () => {},
        { onEphemeralThread: excluded },
      );
      disposers.push(
        stop,
        subscribeCodexCatalogEvents("unrelated-home", () => {}, { onEphemeralThread: otherHome }),
      );
      let ephemeral = true;
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line);
          send({ id: request.id, result: { thread: { id: "helper-thread", ephemeral } } });
        },
      });
      disposers.push(async () => {
        await harness.client.closeAndWait();
      });
      await observeCodexCatalogClient(harness.client, { startOptions: options });

      await expect(harness.client.request(method, {})).resolves.toEqual({
        thread: { id: "helper-thread", ephemeral: true },
      });
      expect(excluded).toHaveBeenCalledExactlyOnceWith("helper-thread");
      expect(otherHome).not.toHaveBeenCalled();

      ephemeral = false;
      await harness.client.request(method, {});
      expect(excluded).toHaveBeenCalledOnce();
      stop();
      ephemeral = true;
      await harness.client.request(method, {});
      expect(excluded).toHaveBeenCalledOnce();
    },
  );

  it("reports physical local closure once and removes close callbacks with their subscription", async () => {
    const options = startOptions(tempDirs.make("codex-catalog-close-"));
    const closed = vi.fn();
    const stop = subscribeCodexCatalogEvents(
      await codexCatalogResidentHomeKey({ startOptions: options }),
      () => {},
      { onClose: closed },
    );
    disposers.push(stop);
    const first = createClientHarness();
    const unsubscribed = createClientHarness();
    disposers.push(
      () => first.client.close(),
      () => unsubscribed.client.close(),
    );
    await observeCodexCatalogClient(first.client, { startOptions: options });
    await observeCodexCatalogClient(first.client, { startOptions: options });
    expect(closed).not.toHaveBeenCalled();
    first.client.close();
    first.client.close();
    expect(closed).toHaveBeenCalledOnce();
    stop();
    await observeCodexCatalogClient(unsubscribed.client, { startOptions: options });
    unsubscribed.client.close();
    expect(closed).toHaveBeenCalledOnce();
    expect([...first.writes, ...unsubscribed.writes]).toEqual([]);
  });

  it("reports each remote client readiness once without native requests or local readiness events", async () => {
    const options = startOptions(tempDirs.make("codex-catalog-ready-"));
    const remoteOptions: CodexAppServerStartOptions = {
      ...options,
      transport: "websocket",
      url: "wss://ready.example.test/codex",
      authToken: "synthetic-ready-credential",
    };
    const remoteReady = vi.fn();
    const localReady = vi.fn();
    const stop = subscribeCodexCatalogEvents(
      await codexCatalogResidentHomeKey({ startOptions: remoteOptions }),
      () => {},
      { onRemoteReady: remoteReady },
    );
    disposers.push(
      stop,
      subscribeCodexCatalogEvents(
        await codexCatalogResidentHomeKey({ startOptions: options }),
        () => {},
        { onRemoteReady: localReady },
      ),
    );
    const local = createClientHarness();
    const first = createClientHarness();
    const replacement = createClientHarness();
    const unsubscribed = createClientHarness();
    for (const harness of [local, first, replacement, unsubscribed]) {
      disposers.push(() => harness.client.close());
    }
    await observeCodexCatalogClient(local.client, { startOptions: options });
    await observeCodexCatalogClient(first.client, { startOptions: remoteOptions });
    await observeCodexCatalogClient(first.client, { startOptions: remoteOptions });
    expect(remoteReady).toHaveBeenCalledOnce();
    expect(localReady).not.toHaveBeenCalled();
    first.client.close();
    await observeCodexCatalogClient(replacement.client, { startOptions: remoteOptions });
    await observeCodexCatalogClient(replacement.client, { startOptions: remoteOptions });
    expect(remoteReady).toHaveBeenCalledTimes(2);
    stop();
    await observeCodexCatalogClient(unsubscribed.client, { startOptions: remoteOptions });
    expect(remoteReady).toHaveBeenCalledTimes(2);
    expect([local, first, replacement, unsubscribed].flatMap((harness) => harness.writes)).toEqual(
      [],
    );
  });

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
    const remoteOptions: CodexAppServerStartOptions = {
      ...options,
      transport: "websocket",
      url: "wss://first.example.test/codex",
      authToken: "synthetic-first-credential",
    };
    const remoteKey = await codexCatalogResidentHomeKey({
      startOptions: remoteOptions,
      sourceHomeId: localKey,
    });
    expect(remoteKey).not.toBe(localKey);
    for (const overrides of [
      { url: "wss://second.example.test/codex" },
      { authToken: "synthetic-second-credential" },
    ]) {
      await expect(
        codexCatalogResidentHomeKey({ startOptions: { ...remoteOptions, ...overrides } }),
      ).resolves.not.toBe(remoteKey);
    }
  });

  it("forwards catalog lifecycle changes once without performing a native request", async () => {
    const options = startOptions(tempDirs.make("codex-catalog-events-"));
    const homeKey = await codexCatalogResidentHomeKey({ startOptions: options });
    const harness = createClientHarness();
    disposers.push(() => harness.client.close());
    const receive = vi.fn();
    const otherHome = vi.fn();
    const stop = subscribeCodexCatalogEvents(homeKey, receive);
    disposers.push(stop, subscribeCodexCatalogEvents(`${homeKey}-other`, otherHome));
    await observeCodexCatalogClient(harness.client, { startOptions: options });
    await observeCodexCatalogClient(harness.client, { startOptions: options });
    const events: CodexServerNotification[] = [
      { method: "thread/started", params: { thread: { id: "thread-1" } } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
      { method: "thread/archived", params: { threadId: "thread-1" } },
      { method: "thread/deleted", params: { threadId: "thread-1" } },
      { method: "thread/unarchived", params: { threadId: "thread-1" } },
      { method: "thread/reverted", params: { threadId: "thread-1" } },
      {
        method: "thread/name/updated",
        params: { threadId: "thread-1", threadName: "New title" },
      },
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
    const options = startOptions(tempDirs.make("codex-catalog-events-"));
    const homeKey = await codexCatalogResidentHomeKey({ startOptions: options });
    const thread = {
      id: "thread-1",
      name: "Updated title",
      preview: "x".repeat(40 * 1024),
      extra: { discarded: "native payload ".repeat(4_096) },
    };
    const harness = createClientHarness();
    disposers.push(async () => {
      await harness.client.closeAndWait();
    });
    let reading: Promise<CodexThread> | undefined;
    disposers.push(
      subscribeCodexCatalogEvents(homeKey, (_event, readThread) => {
        reading = readThread(thread.id);
      }),
    );
    await observeCodexCatalogClient(harness.client, { startOptions: options });
    expect(harness.writes).toEqual([]);
    harness.send({ method: "turn/completed", params: { threadId: thread.id, turn: {} } });
    const request = JSON.parse(await harness.waitForWrite(0));
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: thread.id, includeTurns: false },
    });
    const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
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
