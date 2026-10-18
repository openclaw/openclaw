import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  discordComponentRegistryState,
  type DiscordRegistryStore,
} from "./components-registry-state.js";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "./components-registry.js";
import { clearDiscordComponentEntriesForTest } from "./components-registry.test-support.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

afterEach(() => clearDiscordComponentEntriesForTest());

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
  discordComponentRegistryState.persistentComponentStore = components;
  discordComponentRegistryState.persistentModalStore = modals;
  const componentStarted = createDeferred<void>();
  const modalStarted = createDeferred<void>();
  const componentDone = createDeferred<void>();
  const modalDone = createDeferred<void>();
  vi.spyOn(components, "register").mockImplementation(async () => {
    componentStarted.resolve();
    await componentDone.promise;
  });
  vi.spyOn(modals, "register").mockImplementation(async () => {
    modalStarted.resolve();
    await modalDone.promise;
  });
  let completed = false;
  const registration = Promise.resolve(
    registerDiscordComponentEntries({
      entries: [{ id: "button", kind: "button", label: "Choose" }],
      modals: [{ id: "modal", title: "Details", fields: [] }],
    }),
  ).then(() => {
    completed = true;
  });
  try {
    await componentStarted.promise;
    await setImmediate();
    expect(completed).toBe(false);
    componentDone.resolve();
    await modalStarted.promise;
    await setImmediate();
    expect(completed).toBe(false);
    modalDone.resolve();
    await registration;
    expect(completed).toBe(true);
  } finally {
    componentDone.resolve();
    modalDone.resolve();
    await registration;
  }
});

it.each([false, true])(
  "consumes a group once while its persistent cleanup waits (memory=%s)",
  async (inMemory) => {
    const components = store<DiscordComponentEntry>();
    discordComponentRegistryState.persistentComponentStore = components;
    const entries: DiscordComponentEntry[] = ["confirm", "cancel"].map((id) => ({
      id,
      kind: "button",
      label: id,
      consumptionGroupId: "choice",
      consumptionGroupEntryIds: ["confirm", "cancel"],
    }));
    await registerDiscordComponentEntries({ entries, modals: [] });
    if (!inMemory) {
      discordComponentRegistryState.componentEntries.clear();
    }
    const deleting = createDeferred<void>();
    const deleted = createDeferred<void>();
    const remove = components.delete;
    vi.spyOn(components, "delete").mockImplementation(async (id) => {
      deleting.resolve();
      await deleted.promise;
      return remove(id);
    });
    let completed = false;
    const first = resolveDiscordComponentEntryWithPersistence({ id: "confirm" }).then((entry) => {
      completed = true;
      return entry;
    });
    let sibling: Promise<DiscordComponentEntry | null> | undefined;
    try {
      await deleting.promise;
      sibling = resolveDiscordComponentEntryWithPersistence({ id: "cancel" });
      await setImmediate();
      expect(completed).toBe(false);
      deleted.resolve();
      expect((await first)?.id).toBe("confirm");
      expect(await sibling).toBeNull();
      expect(await components.lookup("cancel")).toBeUndefined();
    } finally {
      deleted.resolve();
      await Promise.allSettled([first, sibling]);
    }
  },
);

it("awaits modal deletion and keeps in-memory fallback when persistence rejects", async () => {
  const modals = store<DiscordModalEntry>();
  discordComponentRegistryState.persistentModalStore = modals;
  await registerDiscordComponentEntries({
    entries: [],
    modals: [{ id: "modal", title: "Details", fields: [] }],
  });
  const deleting = createDeferred<void>();
  const deletion = createDeferred<boolean>();
  vi.spyOn(modals, "delete").mockImplementation(() => {
    deleting.resolve();
    return deletion.promise;
  });
  let completed = false;
  const consumed = resolveDiscordModalEntryWithPersistence({ id: "modal" }).then((entry) => {
    completed = true;
    return entry;
  });
  try {
    await deleting.promise;
    await setImmediate();
    expect(completed).toBe(false);
    deletion.reject(new Error("synthetic persistence failure"));
    expect((await consumed)?.id).toBe("modal");
    expect(discordComponentRegistryState.persistentRegistryDisabled).toBe(true);
    expect(await resolveDiscordModalEntryWithPersistence({ id: "modal" })).toBeNull();
  } finally {
    deletion.resolve(false);
    await consumed;
  }
});

it("captures registration entries and message id before waiting for earlier persistence", async () => {
  const components = store<DiscordComponentEntry>();
  const modals = store<DiscordModalEntry>();
  discordComponentRegistryState.persistentComponentStore = components;
  discordComponentRegistryState.persistentModalStore = modals;
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  vi.spyOn(components, "register").mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  const earlier = registerDiscordComponentEntries({
    entries: [{ id: "earlier", kind: "button", label: "Earlier" }],
    modals: [],
  });
  let queued: Promise<void> | undefined;
  try {
    await started.promise;
    const entry: DiscordComponentEntry = { id: "captured", kind: "button", label: "Captured" };
    const modal: DiscordModalEntry = { id: "captured-modal", title: "Captured modal", fields: [] };
    const params = { entries: [entry], modals: [modal], messageId: "captured-message" };
    queued = registerDiscordComponentEntries(params);
    entry.label = "Changed";
    modal.title = "Changed";
    params.entries.push({ id: "late", kind: "button", label: "Late" });
    params.modals = [];
    params.messageId = "changed-message";
    release.resolve();
    await Promise.all([earlier, queued]);
    expect(
      await resolveDiscordComponentEntryWithPersistence({ id: "captured", consume: false }),
    ).toMatchObject({ label: "Captured", messageId: "captured-message" });
    expect(await components.lookup("captured")).toMatchObject({
      entry: { label: "Captured", messageId: "captured-message" },
    });
    expect(
      await resolveDiscordModalEntryWithPersistence({ id: "captured-modal", consume: false }),
    ).toMatchObject({ title: "Captured modal", messageId: "captured-message" });
    expect(await modals.lookup("captured-modal")).toMatchObject({
      entry: { title: "Captured modal", messageId: "captured-message" },
    });
    expect(
      await resolveDiscordComponentEntryWithPersistence({ id: "late", consume: false }),
    ).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([earlier, queued]);
  }
});
