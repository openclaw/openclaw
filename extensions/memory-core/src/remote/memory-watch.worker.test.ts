import fs from "node:fs/promises";
import path from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalWatchCommand, LocalWatchEvent } from "../memory/local-watch-protocol.js";
import { serveLocalMemoryWatches } from "./memory-watch.worker.js";

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

const request: MemoryWorkspaceWatchRequest = {
  agentId: "main",
  settings: {
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 10 },
  },
};
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const peers: { client: MessagePort; server: Promise<void> }[] = [];

function createPeer(signal: AbortSignal) {
  const { port1, port2 } = new MessageChannel();
  const events: LocalWatchEvent[] = [];
  const pending = new Set<{
    accepts: (event: LocalWatchEvent) => boolean;
    resolve: (event: LocalWatchEvent) => void;
  }>();
  port1.on("message", (event: LocalWatchEvent) => {
    events.push(event);
    for (const waiter of pending) {
      if (waiter.accepts(event)) {
        pending.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  const server = serveLocalMemoryWatches(port2);
  let finished = false;
  void server.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  const peer = {
    client: port1,
    server,
    events,
    get finished() {
      return finished;
    },
    send(command: LocalWatchCommand) {
      port1.postMessage(command);
    },
    waitFor(match: (event: LocalWatchEvent) => boolean, after = 0) {
      const event = events.slice(after).find(match);
      if (event) {
        return Promise.resolve(event);
      }
      return withinTest(
        new Promise<LocalWatchEvent>((resolve) => {
          pending.add({ accepts: match, resolve });
        }),
        signal,
      );
    },
    event(type: LocalWatchEvent["type"], id?: number, after = 0): Promise<LocalWatchEvent> {
      return peer.waitFor(
        (event) => event.type === type && (id === undefined || ("id" in event && event.id === id)),
        after,
      );
    },
    open(id: number, workspaceDir = state.workspaceDir): Promise<LocalWatchEvent> {
      peer.send({ type: "open", id, workspaceDir, request });
      return peer.event("started", id);
    },
  };
  peers.push(peer);
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

beforeEach(async () => {
  observer.reset();
  discovery.pause = undefined;
  vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
  state = await createOpenClawTestState({ label: "local-memory-watch" });
  await fs.mkdir(path.join(state.workspaceDir, "memory"));
  vi.useFakeTimers();
});

afterEach(async () => {
  const active = peers.splice(0);
  for (const peer of active) {
    peer.client.close();
  }
  await Promise.allSettled(active.map((peer) => peer.server));
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await state.cleanup();
});

it("joins close during discovery without publishing readiness or admitting an observation", async ({
  signal,
}) => {
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  discovery.pause = () => {
    entered.resolve();
    return resume.promise;
  };
  const peer = createPeer(signal);
  try {
    peer.send({ type: "open", id: 1, workspaceDir: state.workspaceDir, request });
    await withinTest(entered.promise, signal);
    peer.send({ type: "close", id: 1 });
    // A later command's response proves the server processed the blocked close.
    peer.send({ type: "close", id: 2 });
    await peer.event("closed", 2);
    expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "closed", id: 1 }));
    resume.resolve();
    await peer.event("closed", 1);
    expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "started", id: 1 }));
    expect(observer.observations).toHaveLength(0);
  } finally {
    resume.resolve();
  }
});

it("keeps a same-owner, same-root peer active after the first subscription closes", async ({
  signal,
}) => {
  const peer = createPeer(signal);
  await expect(peer.open(1)).resolves.toMatchObject({
    facts: { health: [{ state: "ready", mode: "events" }], capacityDegraded: false },
  });
  await peer.open(2);
  expect(observer.observations).toHaveLength(1);
  const entry = observer.observations[0]!;
  peer.send({ type: "close", id: 1 });
  await peer.event("closed", 1);
  expect(entry.close).not.toHaveBeenCalled();
  const after = peer.events.length;
  entry.dirty();
  await peer.event("dirty", 2, after);
  expect(peer.events.slice(after)).not.toContainEqual({ type: "dirty", id: 1 });
  await vi.advanceTimersByTimeAsync(10);
  await peer.event("change", 2, after);
  peer.send({ type: "close", id: 2 });
  await peer.event("closed", 2);
  expect(entry.close).toHaveBeenCalledOnce();
});

it("pushes fallback health and sticky capacity exhaustion without a client read", async ({
  signal,
}) => {
  const peer = createPeer(signal);
  await peer.open(1);
  const entry = observer.observations[0]!;
  entry.health({
    state: "ready",
    mode: "poll",
    failure: { operation: "watch", code: "ENOTSUP", error: new Error("native watch unavailable") },
  });
  await expect(
    peer.waitFor((event) => event.type === "state" && event.facts.health[0]?.mode === "poll"),
  ).resolves.toMatchObject({
    id: 1,
    facts: {
      health: [
        {
          pollingFallback: true,
          failure: { code: "ENOTSUP", error: "Error: native watch unavailable" },
        },
      ],
    },
  });
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
  const physical = createDeferred<void>();
  observer.closeBarrier = physical.promise;
  const peer = createPeer(signal);
  try {
    await peer.open(1);
    const entry = observer.observations[0]!;
    const closing = whenClosing(entry);
    peer.client.close();
    await withinTest(closing, signal);
    expect(peer.finished).toBe(false);
    physical.resolve();
    await withinTest(peer.server, signal);
    expect(entry.close).toHaveBeenCalledOnce();
  } finally {
    physical.resolve();
  }
});

it("retains a failed close for shutdown and waits for every other subscription", async ({
  signal,
}) => {
  const failed = createDeferred<void>();
  const physical = createDeferred<void>();
  const peer = createPeer(signal);
  try {
    observer.closeBarrier = failed.promise;
    await peer.open(1);
    observer.closeBarrier = physical.promise;
    const otherWorkspace = state.path("peer", "workspace");
    await fs.mkdir(path.join(otherWorkspace, "memory"), { recursive: true });
    await peer.open(2, otherWorkspace);
    expect(observer.observations).toHaveLength(2);
    const [first, second] = observer.observations;
    const firstClosing = whenClosing(first!);
    const secondClosing = whenClosing(second!);
    peer.send({ type: "close", id: 1 });
    await withinTest(firstClosing, signal);
    failed.reject(new Error("physical teardown failed"));
    await expect(peer.event("closed", 1)).resolves.toMatchObject({
      error: "AggregateError: Memory watcher cleanup failed",
    });
    peer.send({ type: "shutdown" });
    await withinTest(secondClosing, signal);
    expect(peer.finished).toBe(false);
    expect(peer.events).not.toContainEqual(expect.objectContaining({ type: "shutdown" }));
    physical.resolve();
    await expect(peer.event("shutdown")).resolves.toMatchObject({
      error: "AggregateError: Local Memory watcher retirement failed",
    });
    await expect(withinTest(peer.server, signal)).rejects.toThrow(
      "Local Memory watcher retirement failed",
    );
    expect(first!.close).toHaveBeenCalledOnce();
    expect(second!.close).toHaveBeenCalledOnce();
  } finally {
    failed.resolve();
    physical.resolve();
  }
});
