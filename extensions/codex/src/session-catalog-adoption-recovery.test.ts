/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods. */
import { expect, it, vi } from "vitest";
import { createCodexAppServerBindingStore } from "./app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./app-server/session-binding.sqlite.test-helpers.js";
import {
  transcriptMirrorMocks,
  continueLocalCodexSession,
  config,
  idleThread,
  createEligibleControl,
  adoptedEntry,
  supervisionSessionKey,
  seedSupervisionBinding,
  interruptedAdoptionEntry,
  createRuntime,
  createGatewayApi,
  sessionBindingIdentity,
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-catalog.test-helpers.js";

const sourceThreadId = "thread-1";
const sessionKey = supervisionSessionKey(sourceThreadId);
const historyImport = transcriptMirrorMocks.importCodexThreadHistoryToTranscript;

function fixture(entry?: ReturnType<typeof adoptedEntry>) {
  const runtime = createRuntime({ entries: entry ? [{ sessionKey, entry }] : [] });
  const { api } = createGatewayApi(runtime.runtime);
  const bindingStore = createCodexTestBindingStore();
  const sessionId = entry?.sessionId ?? "openclaw-session-existing";
  const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
  return {
    ...runtime,
    bindingStore,
    identity,
    sessionId,
    continue: (control = createEligibleControl(), store = bindingStore) =>
      continueLocalCodexSession({
        api,
        bindingStore: store,
        config,
        control,
        threadId: sourceThreadId,
      }),
    seed: (binding: CodexAppServerThreadBinding) =>
      bindingStore.mutate(identity, { kind: "set", if: { kind: "absent" }, binding }),
    map: () => seedSupervisionBinding({ bindingStore, sessionId, sessionKey, sourceThreadId }),
  };
}

function pendingBinding(
  patch: Partial<CodexAppServerThreadBinding> = {},
): CodexAppServerThreadBinding {
  return {
    threadId: sourceThreadId,
    connectionScope: "supervision",
    supervisionSourceThreadId: sourceThreadId,
    cwd: "/workspace/project",
    historyCoveredThrough: new Date().toISOString(),
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    pendingSupervisionBranch: { sourceThreadId, connectionFingerprint: "catalog-connection" },
    ...patch,
  };
}

it("recovers the same pending session after a restart following binding commit", async () => {
  const f = fixture(
    interruptedAdoptionEntry({ sourceThreadId, sessionId: "interrupted-after-binding" }),
  );
  await f.seed(pendingBinding());
  const mutate = vi.fn(f.bindingStore.mutate);
  const bindingStore: CodexAppServerBindingStore = { ...f.bindingStore, mutate };
  await expect(f.continue(undefined, bindingStore)).resolves.toEqual({
    sessionKey,
    disposition: "forked",
  });
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(f.entries).toHaveLength(1);
  expect(f.entries[0]?.entry.sessionId).toBe(f.sessionId);
  expect(f.entries[0]?.entry.initializationPending).toBeUndefined();
  expect(f.entries[0]?.entry.pluginExtensions).toEqual({
    codex: { supervision: { sourceThreadId, modelLocked: true } },
  });
  expect(mutate).not.toHaveBeenCalled();
  expect(bindingStore.read(f.identity)).toMatchObject({
    threadId: sourceThreadId,
    connectionScope: "supervision",
    supervisionSourceThreadId: sourceThreadId,
    preserveNativeModel: true,
    pendingSupervisionBranch: { sourceThreadId },
  });
});

it.each([
  ["a different working directory", { cwd: "/workspace/other" }],
  [
    "pending cleanup artifacts",
    { pendingSupervisionBranch: { sourceThreadId, cleanupThreadIds: ["thread-orphan"] } },
  ],
] satisfies Array<[string, Partial<CodexAppServerThreadBinding>]>)(
  "rejects recovery against %s in a same-thread binding",
  async (_name, patch) => {
    const f = fixture(
      interruptedAdoptionEntry({ sourceThreadId, sessionId: "interrupted-invalid-binding" }),
    );
    await f.seed(pendingBinding({ pendingSupervisionBranch: { sourceThreadId }, ...patch }));
    await expect(f.continue()).rejects.toThrow("guarded rollback did not complete");
    expect(f.entries[0]?.entry.initializationPending).toBe(true);
  },
);

it.each([true, false])(
  "rejects a Continue when the fresh read returns a different thread (mapped=%s)",
  async (mapped) => {
    const f = fixture(mapped ? adoptedEntry({ sourceThreadId }) : undefined);
    if (mapped) {
      await f.map();
    }
    const control = createEligibleControl({
      readThread: vi.fn(async () => idleThread({ id: "different-thread", source: "cli" })),
    });
    await expect(f.continue(control)).rejects.toThrow("returned a different thread than requested");
    expect(control.readThread).toHaveBeenCalledWith(
      mapped ? "thread-1-branch" : sourceThreadId,
      true,
    );
    expect(f.createSessionEntry).not.toHaveBeenCalled();
    expect(f.patchSessionEntry).not.toHaveBeenCalled();
    expect(historyImport).not.toHaveBeenCalled();
  },
);

it("fails closed when a mapped session generation changes before restore", async () => {
  const f = fixture({
    ...adoptedEntry({ sourceThreadId, sessionId: "openclaw-session-stale" }),
    archivedAt: 123,
  });
  await f.map();
  const control = createEligibleControl({
    readThread: vi.fn(async () => {
      f.entries[0]!.entry.sessionId = "openclaw-session-replacement";
      return idleThread({ id: "thread-1-branch" });
    }),
  });
  await expect(f.continue(control)).rejects.toThrow("changed before it could be opened");
  expect(f.patchSessionEntry).toHaveBeenCalledOnce();
  expect(f.entries[0]?.entry).toMatchObject({ archivedAt: 123, modelSelectionLocked: true });
  expect(f.createSessionEntry).not.toHaveBeenCalled();
});

it("rolls back the session when its pending binding cannot be committed", async () => {
  const f = fixture();
  const inner = createCodexAppServerBindingStore(
    createCodexSqliteTestBindingStateStore({
      namespace: "adoption-rollback",
      maxEntries: 10,
      env: { ...process.env },
    }),
  );
  let rejectBinding = true;
  const mutate = vi.fn(async (...args: Parameters<CodexAppServerBindingStore["mutate"]>) => {
    if (rejectBinding && args[1].kind === "set") {
      rejectBinding = false;
      return false;
    }
    return await inner.mutate(...args);
  });
  const control = createEligibleControl();
  await expect(f.continue(control, { ...inner, mutate })).rejects.toThrow(
    "Codex session binding changed during initialization",
  );
  expect(f.entries).toEqual([]);
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(historyImport).toHaveBeenCalledOnce();
  expect(control.archiveThread).not.toHaveBeenCalled();
});
