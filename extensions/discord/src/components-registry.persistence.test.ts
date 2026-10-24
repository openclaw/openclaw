import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  discordComponentRegistryState as registry,
  type DiscordRegistryStore,
} from "./components-registry-state.js";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence as resolveComponent,
  resolveDiscordModalEntryWithPersistence as resolveModal,
} from "./components-registry.js";
import { clearDiscordComponentEntriesForTest } from "./components-registry.test-support.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

afterEach(() => clearDiscordComponentEntriesForTest());

function button(id: string, options: Partial<DiscordComponentEntry> = {}): DiscordComponentEntry {
  return { id, kind: "button", label: id, ...options };
}
function modal(id: string, options: Partial<DiscordModalEntry> = {}): DiscordModalEntry {
  return { id, title: id, fields: [], ...options };
}

function gate<T = void>() {
  const started = createDeferred<void>();
  const done = createDeferred<T>();
  const wait = () => {
    started.resolve();
    return done.promise;
  };
  return { ...done, started: started.promise, wait };
}

function register(entries: DiscordComponentEntry[], modals: DiscordModalEntry[] = []) {
  return registerDiscordComponentEntries({ entries, modals });
}

function track<T>(promise: Promise<T>) {
  const work = {
    completed: false,
    promise: promise.then((value) => {
      work.completed = true;
      return value;
    }),
  };
  return work;
}

it("retires unclicked expired component and modal entries during registration", async () => {
  const now = 1_700_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const lifetimes = [
      ["expired", now + 1],
      ["live", now + 1_000],
    ] as const;
    await register(
      lifetimes.map(([id, expiresAt]) => button(id, { expiresAt })),
      lifetimes.map(([id, expiresAt]) => modal(id, { expiresAt })),
    );
    clock.mockReturnValue(now + 2);
    await register([button("fresh")], [modal("fresh")]);
    expect([...registry.componentEntries.keys()]).toEqual(["live", "fresh"]);
    expect([...registry.modalEntries.keys()]).toEqual(["live", "fresh"]);
  } finally {
    clock.mockRestore();
  }
});

function store<T extends { id: string }>() {
  const rows = new Map<string, { version: 1; entry: T }>();
  return {
    register: async (id: string, row: { version: 1; entry: T }) => {
      rows.set(id, row);
    },
    lookup: async (id: string) => rows.get(id),
    consume: async (id: string) => {
      const row = rows.get(id);
      rows.delete(id);
      return row;
    },
    delete: async (id: string) => rows.delete(id),
  } satisfies DiscordRegistryStore<T>;
}

it("waits for both component and modal registration before completing", async () => {
  const components = store<DiscordComponentEntry>();
  const modals = store<DiscordModalEntry>();
  registry.persistentComponentStore = components;
  registry.persistentModalStore = modals;
  const componentDone = gate();
  const modalDone = gate();
  vi.spyOn(components, "register").mockImplementation(componentDone.wait);
  vi.spyOn(modals, "register").mockImplementation(modalDone.wait);
  const registration = track(register([button("button")], [modal("modal")]));
  try {
    for (const pending of [componentDone, modalDone]) {
      await pending.started;
      await setImmediate();
      expect(registration.completed).toBe(false);
      pending.resolve();
    }
    await registration.promise;
    expect(registration.completed).toBe(true);
  } finally {
    componentDone.resolve();
    modalDone.resolve();
    await registration.promise;
  }
});

it.each([false, true])(
  "consumes a group once while its persistent cleanup waits (memory=%s)",
  async (inMemory) => {
    const components = store<DiscordComponentEntry>();
    registry.persistentComponentStore = components;
    const entries = ["confirm", "cancel"].map((id) =>
      button(id, {
        consumptionGroupId: "choice",
        consumptionGroupEntryIds: ["confirm", "cancel"],
      }),
    );
    await register(entries);
    if (!inMemory) {
      registry.componentEntries.clear();
    }
    const deleted = gate();
    const remove = components.delete;
    vi.spyOn(components, "delete").mockImplementation(async (id) => {
      await deleted.wait();
      return remove(id);
    });
    const first = track(resolveComponent({ id: "confirm" }));
    let sibling: Promise<DiscordComponentEntry | null> | undefined;
    try {
      await deleted.started;
      sibling = resolveComponent({ id: "cancel" });
      await setImmediate();
      expect(first.completed).toBe(false);
      deleted.resolve();
      expect((await first.promise)?.id).toBe("confirm");
      expect(await sibling).toBeNull();
      expect(await components.lookup("cancel")).toBeUndefined();
    } finally {
      deleted.resolve();
      await Promise.allSettled([first.promise, sibling]);
    }
  },
);

it("awaits modal deletion and keeps in-memory fallback when persistence rejects", async () => {
  const modals = store<DiscordModalEntry>();
  registry.persistentModalStore = modals;
  await register([], [modal("modal")]);
  const deletion = gate<boolean>();
  vi.spyOn(modals, "delete").mockImplementation(deletion.wait);
  const consumed = track(resolveModal({ id: "modal" }));
  try {
    await deletion.started;
    await setImmediate();
    expect(consumed.completed).toBe(false);
    deletion.reject(new Error("synthetic persistence failure"));
    expect((await consumed.promise)?.id).toBe("modal");
    expect(registry.persistentRegistryDisabled).toBe(true);
    expect(await resolveModal({ id: "modal" })).toBeNull();
  } finally {
    deletion.resolve(false);
    await consumed.promise;
  }
});

it("captures registration entries and message id before waiting for earlier persistence", async () => {
  const components = store<DiscordComponentEntry>();
  const modals = store<DiscordModalEntry>();
  registry.persistentComponentStore = components;
  registry.persistentModalStore = modals;
  const release = gate();
  vi.spyOn(components, "register").mockImplementationOnce(release.wait);
  const earlier = register([button("earlier")]);
  let queued: Promise<void> | undefined;
  try {
    await release.started;
    const entry = button("captured", { label: "Captured" });
    const form = modal("captured-modal", { title: "Captured modal" });
    const params = { entries: [entry], modals: [form], messageId: "captured-message" };
    queued = registerDiscordComponentEntries(params);
    entry.label = "Changed";
    form.title = "Changed";
    params.entries.push(button("late"));
    params.modals = [];
    params.messageId = "changed-message";
    release.resolve();
    await Promise.all([earlier, queued]);
    const expectedButton = { label: "Captured", messageId: "captured-message" };
    const expectedModal = { title: "Captured modal", messageId: "captured-message" };
    expect(await resolveComponent({ id: "captured", consume: false })).toMatchObject(
      expectedButton,
    );
    expect(await components.lookup("captured")).toMatchObject({ entry: expectedButton });
    expect(await resolveModal({ id: "captured-modal", consume: false })).toMatchObject(
      expectedModal,
    );
    expect(await modals.lookup("captured-modal")).toMatchObject({ entry: expectedModal });
    expect(await resolveComponent({ id: "late", consume: false })).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([earlier, queued]);
  }
});
