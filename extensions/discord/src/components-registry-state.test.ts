import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  discordComponentRegistryState,
  DiscordRegistryStore,
} from "./components-registry-state.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

type RegistryState = typeof discordComponentRegistryState;
const STATE_KEY = Symbol.for("openclaw.discord.componentRegistryState");
const lifecycle = vi.hoisted(() => ({
  reset: undefined as (() => void | Promise<void>) | undefined,
}));

// mock-isolation: Capture Discord's cleanup at the public SDK boundary without
// registering test-owned callbacks in the host lifecycle. Keep real singleton reuse.
vi.mock("openclaw/plugin-sdk/global-singleton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/global-singleton")>();
  return {
    ...actual,
    resolveGlobalSingleton<T>(
      key: symbol,
      create: () => T,
      reset?: (value: T) => void | Promise<void>,
      resetLifecycle?: Parameters<typeof actual.resolveGlobalSingleton>[3],
    ): T {
      if (key !== Symbol.for("openclaw.discord.componentRegistryState")) {
        return actual.resolveGlobalSingleton(key, create, reset, resetLifecycle);
      }
      const value = actual.resolveGlobalSingleton(key, create);
      lifecycle.reset = reset ? () => reset(value) : undefined;
      return value;
    },
  };
});

async function resetRegisteredState() {
  const reset = lifecycle.reset;
  if (!reset) {
    throw new Error("Discord did not register its lifecycle cleanup");
  }
  await reset();
}

beforeEach(() => {
  vi.resetModules();
  lifecycle.reset = undefined;
  vi.stubGlobal(STATE_KEY, undefined);
  delete (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function createStore<T extends { id: string }>(): DiscordRegistryStore<T> {
  const rows = new Map<string, { version: 1; entry: T }>();
  return {
    register: async (key, value) => {
      rows.set(key, value);
    },
    lookup: async (key) => rows.get(key),
    consume: async (key) => {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    delete: async (key) => rows.delete(key),
  };
}

function createLegacyState(): Omit<RegistryState, "withRegistryLock"> {
  return {
    componentEntries: new Map([["button", { id: "button", kind: "button", label: "Choose" }]]),
    modalEntries: new Map([["modal", { id: "modal", title: "Details", fields: [] }]]),
    persistentComponentStore: createStore<DiscordComponentEntry>(),
    persistentModalStore: createStore<DiscordModalEntry>(),
    persistentRegistryDisabled: true,
  };
}

function loadLegacyState() {
  // The earlier module used the same slot and registered an unlocked reset.
  return resolveGlobalSingleton(STATE_KEY, createLegacyState, (state) => {
    state.componentEntries.clear();
    state.modalEntries.clear();
    state.persistentComponentStore = undefined;
    state.persistentModalStore = undefined;
    state.persistentRegistryDisabled = false;
  });
}

async function loadCurrentState() {
  return (await import("./components-registry-state.js")).discordComponentRegistryState;
}

function expectCleared(state: RegistryState) {
  expect(state.componentEntries.size).toBe(0);
  expect(state.modalEntries.size).toBe(0);
  expect(state.persistentComponentStore).toBeUndefined();
  expect(state.persistentModalStore).toBeUndefined();
  expect(state.persistentRegistryDisabled).toBe(false);
}

describe("Discord component registry singleton upgrades", () => {
  it("cleans a legacy singleton after the current module loads", async () => {
    const legacy = loadLegacyState();
    const before = { ...legacy };
    const state = await loadCurrentState();

    expect(state).toBe(legacy);
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      expect(state[key]).toBe(before[key]);
    }
    expect(state.componentEntries.get("button")?.label).toBe("Choose");
    expect(state.modalEntries.get("modal")?.title).toBe("Details");
    await expect(resetRegisteredState()).resolves.toBeUndefined();
    expectCleared(state);
    expect(state.componentEntries).toBe(before.componentEntries);
    expect(state.modalEntries).toBe(before.modalEntries);
    await expect(state.withRegistryLock(async () => "ready")).resolves.toBe("ready");
  });

  it("normalizes an explicitly undefined legacy lock before consumers use it", async () => {
    const legacy = Object.assign(loadLegacyState(), { withRegistryLock: undefined });
    const state = await loadCurrentState();

    expect(state).toBe(legacy);
    await expect(state.withRegistryLock(async () => "ready")).resolves.toBe("ready");
  });

  it("creates a fresh usable state and reuses it across imports and drains", async () => {
    const state = await loadCurrentState();
    const lock = state.withRegistryLock;
    expectCleared(state);
    await expect(lock(async () => "ready")).resolves.toBe("ready");

    for (let generation = 0; generation < 2; generation++) {
      state.componentEntries.set("button", { id: "button", kind: "button", label: "Choose" });
      vi.resetModules();
      expect(await loadCurrentState()).toBe(state);
      expect(state.withRegistryLock).toBe(lock);
      await resetRegisteredState();
      expectCleared(state);
    }
  });

  it.each(["legacy", "existing lock"])(
    "preserves in-flight work and serializes cleanup across repeated imports (%s)",
    async (origin) => {
      const legacy = loadLegacyState();
      const before = { ...legacy };
      const lock =
        origin === "legacy"
          ? (await loadCurrentState()).withRegistryLock
          : Object.assign(legacy, { withRegistryLock: createAsyncLock() }).withRegistryLock;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const active = lock(async () => {
        events.push("active");
        started.resolve();
        await release.promise;
        events.push("finished");
      });
      const queued = lock(async () => {
        events.push("queued");
        legacy.componentEntries.set("queued", { id: "queued", kind: "button", label: "Queued" });
      });
      let drain: Promise<void> | undefined;
      let afterDrain: Promise<void> | undefined;
      try {
        await started.promise;
        // Exercise old -> new -> old -> new callback ownership as well as reloads.
        expect(loadLegacyState()).toBe(legacy);
        vi.resetModules();
        const state = await loadCurrentState();
        expect(state).toBe(legacy);
        expect(state.withRegistryLock).toBe(lock);
        vi.resetModules();
        expect((await loadCurrentState()).withRegistryLock).toBe(lock);
        drain = resetRegisteredState();
        afterDrain = lock(async () => {
          expectCleared(state);
          events.push("after cleanup");
        });
        expect(events).toEqual(["active"]);
        expect(state.persistentComponentStore).toBe(before.persistentComponentStore);
        expect(state.persistentModalStore).toBe(before.persistentModalStore);
        expect(state.persistentRegistryDisabled).toBe(true);
        expect(state.componentEntries.has("button")).toBe(true);
        release.resolve();
        await Promise.all([active, queued, drain, afterDrain]);
        expect(events).toEqual(["active", "finished", "queued", "after cleanup"]);
      } finally {
        release.resolve();
        await Promise.allSettled([active, queued, drain, afterDrain]);
      }
    },
  );

  it("propagates cleanup errors and allows a subsequent cleanup", async () => {
    loadLegacyState();
    const state = await loadCurrentState();
    const error = new Error("synthetic cleanup failure");
    vi.spyOn(state.componentEntries, "clear").mockImplementationOnce(() => {
      throw error;
    });

    await expect(resetRegisteredState()).rejects.toBe(error);
    await resetRegisteredState();
    expectCleared(state);
  });

  it.each([null, false, {}])(
    "does not silently repair a corrupt, defined lock (%j)",
    async (lock) => {
      Object.assign(loadLegacyState(), { withRegistryLock: lock });
      const state = await loadCurrentState();

      expect(state.withRegistryLock).toBe(lock);
      await expect(resetRegisteredState()).rejects.toBeInstanceOf(TypeError);
      expect(state.componentEntries.has("button")).toBe(true);
    },
  );
});
