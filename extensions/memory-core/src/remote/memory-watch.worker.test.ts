import fs from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
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

const fixture = memoryWatchFixture(() => observer.reset(), "local-memory-watch");

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
    async waitFor(match: (event: LocalWatchEvent) => boolean, after = 0) {
      for (;;) {
        const existing = events.slice(after).find(match);
        if (existing) {
          return existing;
        }
        await withinTest(changed.promise, signal);
      }
    },
    event(type: LocalWatchEvent["type"], id?: number, after = 0): Promise<LocalWatchEvent> {
      return peer.waitFor(
        (event) => event.type === type && (id === undefined || ("id" in event && event.id === id)),
        after,
      );
    },
    open(id: number, workspaceDir = fixture.state.workspaceDir): Promise<LocalWatchEvent> {
      peer.send({ type: "open", id, workspaceDir, request });
      return peer.event("started", id);
    },
    close(id: number) {
      peer.send({ type: "close", id });
      return peer.event("closed", id);
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

beforeEach(() => {
  discovery.pause = undefined;
  vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
});

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
  await peer.close(2);
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "closed", id: 1 }));
  resume.resolve();
  await peer.event("closed", 1);
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "started", id: 1 }));
  expect(observer.observations).toHaveLength(0);
});

it("keeps a shared-root peer active after the first subscription closes", async ({ signal }) => {
  const peer = createPeer(signal);
  await expect(peer.open(1)).resolves.toMatchObject({
    facts: { health: [{ state: "ready", mode: "events" }], capacityDegraded: false },
  });
  await peer.open(2);
  expect(observer.observations).toHaveLength(1);
  const entry = observer.observations[0]!;
  await peer.close(1);
  expect(entry.close).not.toHaveBeenCalled();
  const after = peer.events.length;
  entry.dirty();
  await peer.event("dirty", 2, after);
  expect(peer.events.slice(after)).not.toContainEqual({ type: "dirty", id: 1 });
  await vi.advanceTimersByTimeAsync(10);
  await peer.event("change", 2, after);
  await peer.close(2);
  expect(entry.close).toHaveBeenCalledOnce();
});

it("pushes fallback health and sticky capacity exhaustion", async ({ signal }) => {
  const peer = createPeer(signal);
  await peer.open(1);
  const entry = observer.observations[0]!;
  entry.health({
    state: "ready",
    mode: "poll",
    failure: { operation: "watch", code: "ENOTSUP", error: new Error("native") },
  });
  const fallback = {
    pollingFallback: true,
    failure: { code: "ENOTSUP", error: "Error: native" },
  };
  await expect(
    peer.waitFor((event) => event.type === "state" && event.facts.health[0]?.mode === "poll"),
  ).resolves.toMatchObject({ id: 1, facts: { health: [fallback] } });
  entry.health({
    state: "unavailable",
    failure: { operation: "watch", code: "watch-limit", error: new Error("watch limit") },
  });
  await peer.waitFor((event) => event.type === "state" && event.facts.capacityDegraded);
  await peer.event("unavailable", 1);
  await peer.event("dirty", 1);
  await expect(
    peer.waitFor(
      (event) =>
        event.type === "state" && event.facts.capacityDegraded && event.facts.health.length === 0,
    ),
  ).resolves.toMatchObject({ id: 1 });
});

it("joins native retirement when the client port disappears", async ({ signal }) => {
  const physical = fixture.barrier();
  observer.closeBarrier = physical.promise;
  const peer = createPeer(signal);
  await peer.open(1);
  const entry = observer.observations[0]!;
  const closing = whenClosing(entry);
  peer.client.close();
  await withinTest(closing, signal);
  expect(peer.finished).not.toHaveBeenCalled();
  physical.resolve();
  await withinTest(peer.server, signal);
  expect(entry.close).toHaveBeenCalledOnce();
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
  expect(observer.observations).toHaveLength(2);
  const [first, second] = observer.observations;
  const firstClosing = whenClosing(first!);
  const secondClosing = whenClosing(second!);
  const closed = peer.close(1);
  await withinTest(firstClosing, signal);
  failed.reject(new Error("physical teardown failed"));
  await expect(closed).resolves.toMatchObject({
    error: "AggregateError: Memory watcher cleanup failed",
  });
  peer.send({ type: "shutdown" });
  await withinTest(secondClosing, signal);
  expect(peer.finished).not.toHaveBeenCalled();
  expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "shutdown" }));
  physical.resolve();
  const error = "Local Memory watcher retirement failed";
  await expect(peer.event("shutdown")).resolves.toMatchObject({
    error: `AggregateError: ${error}`,
  });
  await expect(withinTest(peer.server, signal)).rejects.toThrow(error);
  expect(first!.close).toHaveBeenCalledOnce();
  expect(second!.close).toHaveBeenCalledOnce();
});
