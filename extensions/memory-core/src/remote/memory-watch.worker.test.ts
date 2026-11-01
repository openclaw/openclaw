import fs from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import type { LocalWatchCommand, LocalWatchEvent } from "../memory/local-watch-protocol.js";
import { serveLocalMemoryWatches } from "./memory-watch.worker.js";
import { memoryWatchFixture, request } from "./memory-worker.test-support.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("../memory/watcher-test-support.js");
  return createMemoryObservationHarness();
});
const discovery = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return {
    ...actual,
    watch: observer.watch,
    admitObservationRoot: async (...args: Parameters<typeof actual.admitObservationRoot>) => {
      const root = await actual.admitObservationRoot(...args);
      await discovery.pause?.();
      return root;
    },
  };
});

const fixture = memoryWatchFixture(() => {
  observer.reset();
  discovery.pause = undefined;
  vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
}, "local-memory-watch");

function createPeer(signal: AbortSignal) {
  const { port1, port2 } = new MessageChannel();
  const events: LocalWatchEvent[] = [];
  let changed = createDeferred<void>();
  port1.on("message", (event: LocalWatchEvent) => {
    events.push(event);
    changed.resolve();
    changed = createDeferred<void>();
  });
  const server = serveLocalMemoryWatches(port2);
  fixture.cleanup(async () => {
    port1.close();
    await server.catch(() => {});
  });
  const finished = vi.fn();
  void server.then(finished, finished);
  const peer = {
    client: port1,
    server,
    events,
    finished,
    send: (command: LocalWatchCommand) => port1.postMessage(command),
    async event(expected: Record<string, unknown>) {
      const match = expect.objectContaining(expected);
      let existing: LocalWatchEvent | undefined;
      while (!(existing = events.find((event) => match.asymmetricMatch(event)))) {
        await withinTest(changed.promise, signal);
      }
      return existing;
    },
    open(id: number, workspaceDir = fixture.state.workspaceDir): Promise<LocalWatchEvent> {
      peer.send({ type: "open", id, workspaceDir, request });
      return peer.event({ type: "started", id });
    },
  };
  return peer;
}

function whenClosing(entry: (typeof observer.observations)[number]) {
  const called = createDeferred<void>();
  const close = entry.close.getMockImplementation()!;
  entry.close.mockImplementation(() => {
    called.resolve();
    return close();
  });
  return called.promise;
}

it("joins discovery close without readiness or observation admission", async ({ signal }) => {
  const entered = createDeferred<void>();
  const resume = fixture.barrier();
  discovery.pause = () => {
    entered.resolve();
    return resume.promise;
  };
  const peer = createPeer(signal);
  peer.send({ type: "open", id: 1, workspaceDir: fixture.state.workspaceDir, request });
  await withinTest(entered.promise, signal);
  peer.send({ type: "close", id: 1 });
  // A later command's response proves the server processed the blocked close.
  peer.send({ type: "close", id: 2 });
  await peer.event({ type: "closed", id: 2 });
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "closed", id: 1 }));
  resume.resolve();
  await peer.event({ type: "closed", id: 1 });
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "started", id: 1 }));
  expect(observer.observations).toHaveLength(0);
});

it("pushes capacity exhaustion and invalidation over the worker port", async ({ signal }) => {
  const peer = createPeer(signal);
  await peer.open(1);
  observer.observations[0]!.health({
    state: "unavailable",
    failure: { operation: "watch", code: "watch-limit", error: new Error("watch limit") },
  });
  await peer.event({ type: "unavailable", id: 1 });
  await peer.event({ type: "dirty", id: 1 });
  await peer.event({
    type: "state",
    id: 1,
    facts: expect.objectContaining({ capacityDegraded: true, health: [] }),
  });
});

it("joins native retirement when the client port disappears", async ({ signal }) => {
  const physical = fixture.barrier();
  observer.closeBarrier = physical.promise;
  const peer = createPeer(signal);
  await peer.open(1);
  const closing = whenClosing(observer.observations[0]!);
  peer.client.close();
  await withinTest(closing, signal);
  expect(peer.finished).not.toHaveBeenCalled();
  physical.resolve();
  await withinTest(peer.server, signal);
});

it("retains close failures and joins every subscription on shutdown", async ({ signal }) => {
  const failed = fixture.barrier();
  const physical = fixture.barrier();
  const peer = createPeer(signal);
  observer.closeBarrier = failed.promise;
  await peer.open(1);
  observer.closeBarrier = physical.promise;
  const otherWorkspace = fixture.state.path("peer", "workspace");
  await fs.mkdir(otherWorkspace, { recursive: true });
  await peer.open(2, otherWorkspace);
  const [firstClosing, secondClosing] = observer.observations.map(whenClosing);
  peer.send({ type: "close", id: 1 });
  const closed = peer.event({ type: "closed", id: 1 });
  await withinTest(firstClosing!, signal);
  failed.reject(new Error("physical teardown failed"));
  await expect(closed).resolves.toMatchObject({
    error: "AggregateError: Memory watcher cleanup failed",
  });
  peer.send({ type: "shutdown" });
  await withinTest(secondClosing!, signal);
  expect(peer.finished).not.toHaveBeenCalled();
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "shutdown" }));
  physical.resolve();
  const error = "Local Memory watcher retirement failed";
  await peer.event({ type: "shutdown", error: `AggregateError: ${error}` });
  await expect(withinTest(peer.server, signal)).rejects.toThrow(error);
});
