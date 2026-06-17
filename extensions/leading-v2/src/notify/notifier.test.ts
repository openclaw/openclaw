import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import type { BackendConfig } from "../client/types.js";
import { CompletionNotifier, type DeliverFn } from "./notifier.js";
import { PendingTaskRegistry } from "./pending-store.js";
import type { PendingTask, PollAdapter } from "./types.js";

const logger: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} } as PluginLogger;
const config = { baseUrl: "https://x", timeoutMs: 1000, siteId: "legal", apiKeys: {} } as BackendConfig;

function task(overrides: Partial<PendingTask> = {}): PendingTask {
  const now = Date.now();
  return {
    id: "crawl_refresh:U1",
    kind: "crawl_refresh",
    uid: "1749",
    backendId: "U1",
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:s1",
    mercureTopic: "1749",
    delivery: { channel: "telegram", to: "u1" },
    title: "刷新A",
    createdAt: now,
    attempts: 0,
    notified: false,
    expiresAt: now + 3_600_000,
    ...overrides,
  };
}

function makeNotifier(adapter: PollAdapter, deliver: DeliverFn = vi.fn().mockResolvedValue(undefined)) {
  const registry = new PendingTaskRegistry();
  const resolver = new ApiKeyResolver({ "1749": "sk_x" }, undefined);
  const notifier = new CompletionNotifier({
    registry,
    resolver,
    config,
    notify: { enabled: true, pollIntervalMs: 1000, ttlMs: 3_600_000, maxPerTick: 5 },
    deliver,
    logger,
    adapters: { crawl_refresh: adapter },
  });
  return { registry, notifier, deliver };
}

describe("CompletionNotifier.tick", () => {
  it("delivers and removes the task when the adapter reports terminal", async () => {
    const adapter: PollAdapter = vi.fn().mockResolvedValue({ terminal: true, summary: "done: 转10" });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { registry, notifier } = makeNotifier(adapter, deliver);
    registry.add(task());

    await notifier.tick();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [deliveredTask, summary] = deliver.mock.calls[0];
    expect(deliveredTask).toMatchObject({ id: "crawl_refresh:U1", uid: "1749" });
    expect(String(summary)).toContain("done: 转10");
    expect(registry.all()).toHaveLength(0); // removed after delivery
  });

  it("keeps polling (no deliver) while the adapter reports non-terminal", async () => {
    const adapter: PollAdapter = vi.fn().mockResolvedValue({ terminal: false, summary: "" });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { registry, notifier } = makeNotifier(adapter, deliver);
    registry.add(task());

    await notifier.tick();

    expect(deliver).not.toHaveBeenCalled();
    expect(registry.all()[0]).toMatchObject({ notified: false, attempts: 1 });
  });

  it("does not re-deliver an already-notified task", async () => {
    const adapter: PollAdapter = vi.fn().mockResolvedValue({ terminal: true, summary: "x" });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { registry, notifier } = makeNotifier(adapter, deliver);
    registry.add(task({ notified: true }));

    await notifier.tick();

    expect(adapter).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("counts an attempt and keeps the task when the adapter throws", async () => {
    const adapter: PollAdapter = vi.fn().mockRejectedValue(new Error("boom"));
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { registry, notifier } = makeNotifier(adapter, deliver);
    registry.add(task());

    await notifier.tick();

    expect(deliver).not.toHaveBeenCalled();
    expect(registry.all()[0]).toMatchObject({ attempts: 1, notified: false });
  });

  it("prunes expired tasks", async () => {
    const adapter: PollAdapter = vi.fn().mockResolvedValue({ terminal: false, summary: "" });
    const { registry, notifier } = makeNotifier(adapter);
    registry.add(task({ expiresAt: Date.now() - 1 }));

    await notifier.tick();

    expect(registry.all()).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();
  });
});
