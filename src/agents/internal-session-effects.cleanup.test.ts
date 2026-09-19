import { beforeEach, describe, expect, it, vi } from "vitest";
import type { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import { shouldRemoveSessionEntry } from "../config/sessions/session-accessor.sqlite-lifecycle-state.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";

type LifecycleMutation = Parameters<typeof applySessionEntryLifecycleMutation>[0];

const { state, remove, loadEntry } = vi.hoisted(() => {
  const storageState: { entry?: InternalSessionEntry; beforeRemoval?: () => Promise<void> } = {};
  return {
    state: storageState,
    remove: vi.fn<(params: LifecycleMutation) => Promise<void>>(),
    loadEntry: vi.fn<() => { entry: InternalSessionEntry } | undefined>(),
  };
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionEntryLifecycleMutation: remove,
  loadExactSessionEntry: loadEntry,
  forkSessionFromParentTranscript: vi.fn(),
  replaceTranscriptEvents: vi.fn(),
  upsertSessionEntryCore: vi.fn(),
}));

const target = {
  agentId: "main",
  sessionId: "companion-session",
  sessionKey: "agent:main:internal:companion-session",
  storePath: "/synthetic/companion/openclaw-agent.sqlite",
};
const ownedEntry = {
  sessionId: target.sessionId,
  lifecycleRevision: "companion-lifecycle",
  activeWriterRunId: "companion-writer",
  updatedAt: 1,
};
const expectedOwner = {
  lifecycleRevision: ownedEntry.lifecycleRevision,
  activeWriterRunId: ownedEntry.activeWriterRunId,
};

beforeEach(() => {
  state.entry = { ...ownedEntry };
  state.beforeRemoval = undefined;
  loadEntry
    .mockReset()
    .mockImplementation(() => (state.entry ? { entry: structuredClone(state.entry) } : undefined));
  remove.mockReset().mockImplementation(async ({ removals }) => {
    await state.beforeRemoval?.();
    for (const removal of removals ?? []) {
      if (shouldRemoveSessionEntry(state.entry, removal)) {
        state.entry = undefined;
      }
    }
  });
});

describe("internal session cleanup ownership", () => {
  it.each([
    { name: "lifecycle", change: { lifecycleRevision: "replacement-lifecycle" } },
    { name: "writer", change: { activeWriterRunId: "replacement-writer" } },
  ])("preserves a changed $name before guarded cleanup", async ({ change }) => {
    const replacement = { ...ownedEntry, ...change };
    state.entry = replacement;
    await removeInternalSessionEffectsSession(target, expectedOwner);
    expect(state.entry).toEqual(replacement);
  });

  it.each([
    { name: "lifecycle", change: { lifecycleRevision: "replacement-lifecycle" } },
    { name: "writer", change: { activeWriterRunId: "replacement-writer" } },
  ])("preserves a $name change during removal preparation", async ({ change }) => {
    const planned = createDeferredCore();
    const resume = createDeferredCore();
    state.beforeRemoval = async () => {
      planned.resolve();
      await resume.promise;
    };
    const cleanup = removeInternalSessionEffectsSession(target, expectedOwner);
    try {
      await planned.promise;
      const replacement = { ...ownedEntry, ...change };
      state.entry = replacement;
      resume.resolve();
      await cleanup;
      expect(state.entry).toEqual(replacement);
    } finally {
      resume.resolve();
      await cleanup;
    }
  });

  it("removes the original owner after its ordinary metadata changes", async () => {
    state.entry = { ...ownedEntry, updatedAt: 2, label: "Seeded history" };
    await removeInternalSessionEffectsSession(target, expectedOwner);
    expect(state.entry).toBeUndefined();
  });

  it("preserves normal run-owned cleanup after a writer handoff", async () => {
    state.entry = { ...ownedEntry, activeWriterRunId: "embedded-writer" };
    await removeInternalSessionEffectsSession(target);
    expect(state.entry).toBeUndefined();
    expect(loadEntry).not.toHaveBeenCalled();
  });
});
