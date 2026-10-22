import { beforeEach, expect, it, vi } from "vitest";
import type { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import { shouldRemoveSessionEntry } from "../config/sessions/session-accessor.sqlite-lifecycle-state.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";

type LifecycleMutation = Parameters<typeof applySessionEntryLifecycleMutation>[0];
const { state, remove, loadEntry } = vi.hoisted(() => {
  const storage: { entry?: InternalSessionEntry; beforeRemoval?: () => Promise<void> } = {};
  return {
    state: storage,
    remove: vi.fn<(params: LifecycleMutation) => Promise<void>>(),
    loadEntry: vi.fn<() => Promise<InternalSessionEntry | undefined>>(),
  };
});

// mock-isolation: Control lifecycle mutations so ownership can change while cleanup is admitted.
vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionEntryLifecycleMutation: remove,
  forkSessionFromParentTranscript: vi.fn(),
  upsertSessionEntryCore: vi.fn(),
}));
// mock-isolation: Read controlled state without opening a database worker.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: loadEntry,
}));

const target = {
  agentId: "main",
  sessionId: "companion-session",
  sessionKey: "agent:main:internal:companion-session",
  storePath: "/synthetic/companion/openclaw-agent.sqlite",
};
const owner = { lifecycleRevision: "life", activeWriterRunId: "writer" };
const ownedEntry = { sessionId: target.sessionId, ...owner, updatedAt: 1 };
beforeEach(() => {
  state.entry = { ...ownedEntry };
  state.beforeRemoval = undefined;
  loadEntry
    .mockReset()
    .mockImplementation(async () => (state.entry ? structuredClone(state.entry) : undefined));
  remove.mockReset().mockImplementation(async ({ removals }) => {
    await state.beforeRemoval?.();
    for (const removal of removals ?? []) {
      if (shouldRemoveSessionEntry(state.entry, removal)) {
        state.entry = undefined;
      }
    }
  });
});

it.each([
  ["lifecycleRevision", false],
  ["activeWriterRunId", false],
  ["lifecycleRevision", true],
  ["activeWriterRunId", true],
] as const)("preserves changed %s (during preparation: %s)", async (field, during) => {
  const replacement = { ...ownedEntry, [field]: "replacement" };
  if (during) {
    state.beforeRemoval = async () => {
      state.entry = replacement;
    };
  } else {
    state.entry = replacement;
  }
  await removeInternalSessionEffectsSession(target, owner);
  expect(state.entry).toEqual(replacement);
});

it("removes the original owner after ordinary metadata changes", async () => {
  state.entry = { ...ownedEntry, updatedAt: 2, label: "Seeded history" };
  await removeInternalSessionEffectsSession(target, owner);
  expect(state.entry).toBeUndefined();
});

it("preserves run-owned cleanup after a writer handoff", async () => {
  state.entry = { ...ownedEntry, activeWriterRunId: "embedded-writer" };
  await removeInternalSessionEffectsSession(target);
  expect(state.entry).toBeUndefined();
  expect(loadEntry).not.toHaveBeenCalled();
});
