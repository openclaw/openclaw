import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  HumanInterventionConflictError,
  HumanInterventionService,
  type HumanInterventionRecord,
} from "./service.js";

function createMemoryStore(): PluginStateKeyedStore<HumanInterventionRecord> {
  const values = new Map<string, HumanInterventionRecord>();
  return {
    async register(key, value) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, structuredClone(next));
      return true;
    },
    async deleteIf(key, predicate) {
      const current = values.get(key);
      return current !== undefined && predicate(current) ? values.delete(key) : false;
    },
    async lookup(key) {
      const value = values.get(key);
      return value ? structuredClone(value) : undefined;
    },
    async lookupMany(keys) {
      return keys.map((key) => ({ ok: true as const, value: values.get(key) }));
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value ? structuredClone(value) : undefined;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.createdAtMs,
      }));
    },
    async clear() {
      values.clear();
    },
  };
}

function request(service: HumanInterventionService, overrides = {}) {
  return service.request({
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:42",
    owner: { channel: "telegram", accountId: "default", senderId: "42" },
    origin: { channel: "telegram", accountId: "default", to: "42" },
    browser: { target: "host", profile: "openclaw", targetId: "tab-1" },
    reason: "Human verification required",
    hostname: "example.com",
    ...overrides,
  });
}

describe("HumanInterventionService", () => {
  it("uses direct reads after locating an ID and observes another writer's updates", async () => {
    const store = createMemoryStore();
    const first = new HumanInterventionService(store);
    const pending = await request(first);
    const reader = new HumanInterventionService(store);
    const entries = vi.spyOn(store, "entries");
    await reader.get(pending.id);
    const scans = entries.mock.calls.length;
    await first.claim({ id: pending.id, controllerId: "phone-a" });
    await expect(reader.get(pending.id)).resolves.toMatchObject({ state: "control" });
    await expect(reader.get(pending.id)).resolves.toMatchObject({ controllerId: "phone-a" });
    expect(entries).toHaveBeenCalledTimes(scans);
  });

  it("never resolves a cached old ID to a replacement handoff on the same profile", async () => {
    const store = createMemoryStore();
    const writer = new HumanInterventionService(store);
    const first = await request(writer);
    const reader = new HumanInterventionService(store);
    await reader.get(first.id);
    await writer.cancel(first.id);
    const replacement = await request(writer);
    await expect(reader.get(first.id)).rejects.toThrow("not found");
    await expect(reader.get(replacement.id)).resolves.toMatchObject({
      id: replacement.id,
      state: "waiting",
    });
  });

  it("checks the handoff deadline when a queued claim actually commits", async () => {
    const store = createMemoryStore();
    let now = 1_000;
    const service = new HumanInterventionService(store, {
      now: () => now,
      pendingTtlMs: 100,
    });
    const pending = await request(service);
    const update = store.update;
    if (!update) {
      throw new Error("atomic update missing");
    }
    store.update = async (key, mutate) => {
      now = 1_101;
      return await update(key, mutate);
    };
    await expect(service.claim({ id: pending.id, controllerId: "phone-a" })).rejects.toThrow(
      "expired",
    );
    await expect(service.get(pending.id)).resolves.toMatchObject({ state: "expired" });
  });

  it("reserves a profile and rejects a competing task", async () => {
    const store = createMemoryStore();
    const service = new HumanInterventionService(store, {
      now: () => 1_000,
      randomId: () => "handoff-1",
    });

    await expect(request(service)).resolves.toMatchObject({
      id: "handoff-1",
      state: "waiting",
      generation: 1,
      browser: { profile: "openclaw", targetId: "tab-1" },
    });
    await expect(
      request(service, { sessionKey: "agent:main:whatsapp:direct:7" }),
    ).rejects.toBeInstanceOf(HumanInterventionConflictError);
  });

  it("claims, reconnects, leaves paused, and rejects stale control", async () => {
    const store = createMemoryStore();
    const service = new HumanInterventionService(store, {
      now: () => 1_000,
      randomId: () => "handoff-1",
    });
    const pending = await request(service);
    const claimed = await service.claim({ id: pending.id, controllerId: "phone-a" });
    const reconnected = await service.claim({ id: pending.id, controllerId: "phone-a" });
    expect(reconnected.generation).toBe(claimed.generation);

    const waiting = await service.leave({
      id: pending.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    expect(waiting.state).toBe("waiting");
    await expect(
      service.complete({
        id: pending.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      }),
    ).rejects.toBeInstanceOf(HumanInterventionConflictError);
  });

  it("rechecks live authority inside the atomic control transition", async () => {
    const store = createMemoryStore();
    const service = new HumanInterventionService(store, {
      now: () => 1_000,
      randomId: () => "handoff-1",
    });
    const pending = await request(service);

    await expect(
      service.claim({ id: pending.id, controllerId: "phone-a" }, () => {
        throw new Error("operator connection closed");
      }),
    ).rejects.toThrow("operator connection closed");
    await expect(service.get(pending.id)).resolves.toMatchObject({
      state: "waiting",
      generation: 1,
    });
  });

  it("fences a controller after its lease expires", async () => {
    const store = createMemoryStore();
    let now = 1_000;
    const service = new HumanInterventionService(store, {
      now: () => now,
      randomId: () => "handoff-1",
      controlLeaseMs: 100,
    });
    const pending = await request(service);
    const claimed = await service.claim({ id: pending.id, controllerId: "phone-a" });
    await expect(
      service.authorizeControl({
        id: pending.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      }),
    ).resolves.toMatchObject({ state: "control", controllerId: "phone-a" });
    now = 1_101;

    await expect(
      service.authorizeControl({
        id: pending.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      }),
    ).rejects.toBeInstanceOf(HumanInterventionConflictError);

    const replacement = await service.claim({ id: pending.id, controllerId: "phone-b" });
    expect(replacement).toMatchObject({ controllerId: "phone-b", generation: 3 });
  });

  it("expires the handoff-wide deadline even while the controller lease is valid", async () => {
    const store = createMemoryStore();
    let now = 1_000;
    const service = new HumanInterventionService(store, {
      now: () => now,
      randomId: () => "handoff-1",
      pendingTtlMs: 100,
      controlLeaseMs: 1_000,
    });
    const pending = await request(service);
    const claimed = await service.claim({ id: pending.id, controllerId: "phone-a" });
    now = 1_101;

    await expect(
      service.authorizeControl({
        id: pending.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      }),
    ).rejects.toBeInstanceOf(HumanInterventionConflictError);
    await expect(service.get(pending.id)).resolves.toMatchObject({
      state: "expired",
      controllerId: undefined,
    });
    await expect(
      service.getProfileReservation({ target: "host", profile: "openclaw", targetId: "tab-1" }),
    ).resolves.toBeUndefined();
  });

  it("persists one completion event across service restarts", async () => {
    const store = createMemoryStore();
    let nextId = 0;
    const options = { now: () => 1_000, randomId: () => `id-${++nextId}` };
    const first = new HumanInterventionService(store, options);
    const pending = await request(first);
    const claimed = await first.claim({ id: pending.id, controllerId: "phone-a" });
    const completed = await first.complete({
      id: pending.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    expect(completed).toMatchObject({ state: "resume_pending", continuationId: "id-2" });

    const restarted = new HumanInterventionService(store, options);
    const retry = await restarted.complete({
      id: pending.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    expect(retry.continuationId).toBe(completed.continuationId);
    await expect(restarted.cancel(pending.id)).resolves.toMatchObject({
      state: "resume_pending",
      continuationId: completed.continuationId,
    });
    await restarted.markContinuationAdmitted({
      id: pending.id,
      continuationId: completed.continuationId!,
    });
    await expect(restarted.listResumePending()).resolves.toEqual([]);
  });

  it("expires a resume that could not be scheduled and releases its profile", async () => {
    const store = createMemoryStore();
    let now = 1_000;
    let nextId = 0;
    const service = new HumanInterventionService(store, {
      now: () => now,
      randomId: () => `id-${++nextId}`,
      pendingTtlMs: 100,
    });
    const pending = await request(service);
    const claimed = await service.claim({ id: pending.id, controllerId: "phone-a" });
    await service.complete({
      id: pending.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    now = 1_101;

    await expect(service.listResumePending()).resolves.toEqual([]);
    await expect(service.get(pending.id)).resolves.toMatchObject({ state: "expired" });
    await expect(
      service.getProfileReservation({ target: "host", profile: "openclaw", targetId: "tab-1" }),
    ).resolves.toBeUndefined();
  });

  it("expires an abandoned handoff and allows a new reservation", async () => {
    const store = createMemoryStore();
    let now = 1_000;
    let nextId = 0;
    const service = new HumanInterventionService(store, {
      now: () => now,
      randomId: () => `handoff-${++nextId}`,
      pendingTtlMs: 100,
    });
    const first = await request(service);
    now = 1_101;
    await expect(service.get(first.id)).resolves.toMatchObject({ state: "expired" });
    await expect(request(service)).resolves.toMatchObject({ id: "handoff-2", state: "waiting" });
  });
});
