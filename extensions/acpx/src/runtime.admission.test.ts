import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AcpxRuntime as BaseAcpxRuntime,
  RequestedModelUnsupportedError,
  type AcpSessionStore,
} from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createHeldCall,
  createTestGate,
  ownerRuntimeOptions,
  promptJson,
  withProcessRuntime,
} from "./runtime-process.test-support.js";
import { acpxOperationScope } from "./runtime-session-store.js";
import { admissionRetentionEntrypoint } from "./runtime.admission-retention-entrypoint.test-support.js";
import { AcpxRuntime } from "./runtime.js";
import {
  makeRuntime,
  makeManagedRuntime,
  makeEmptySessionStore,
  makeSessionStore,
} from "./runtime.test-support.js";

type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
const admissionTarget = { sessionKey: "admission-project", agentId: "main" };
const admissionInput = { ...admissionTarget, agent: "fixture", mode: "persistent" as const };

afterEach(() => vi.restoreAllMocks());

function withFixture(run: Parameters<typeof withProcessRuntime>[1]) {
  return withProcessRuntime("acpx-admission", run, {
    openclawToolsMcpBridgeEnabled: true,
    mcpServers: [{ name: "openclaw-tools", command: process.execPath, args: [], env: [] }],
  });
}

async function persistedHandle(runtime: AcpxRuntime) {
  try {
    return await runtime.ensureSession(admissionInput);
  } finally {
    await runtime.shutdown();
  }
}

const readContext = (runtime: AcpxRuntime, handle: RuntimeHandle): Promise<unknown> =>
  promptJson(runtime, handle, "show context", "admission-proof");

type Gate = ReturnType<typeof createTestGate>;
async function atGate(
  gate: Gate,
  pending: Parameters<Gate["settle"]>,
  runtime: AcpxRuntime | undefined,
  run: () => Promise<void>,
) {
  try {
    await gate.entered;
    await run();
  } finally {
    await gate.settle(...pending);
    await runtime?.shutdown();
  }
}

it("preserves a queued same-key admission when its predecessor fails", async () => {
  await withFixture(async ({ create }) => {
    const launch = createTestGate();
    let launches = 0;
    const runtime = create({
      processLifecycle: {
        onBeforeSpawn: async () => {
          if (++launches === 1) {
            await launch.hold();
            throw new Error("first launch failed");
          }
        },
      },
    });
    const first = runtime.ensureSession(admissionInput);
    const rejected = expect(first).rejects.toThrow("first launch failed");
    const pending: Promise<unknown>[] = [first];
    await atGate(launch, pending, undefined, async () => {
      const second = runtime.ensureSession(admissionInput);
      pending.push(second);
      launch.release();
      await rejected;
      const handle = await second;
      expect(await readContext(runtime, handle)).toMatchObject({
        mcpServers: [
          {
            name: "openclaw-tools",
            env: [
              { name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: admissionTarget.sessionKey },
            ],
          },
        ],
      });
    });
  });
}, 25_000);

it("retains captured stored-record custody when admission later fails", async () => {
  await withFixture(async ({ runtime: initial, create, store }) => {
    const existing = await persistedHandle(initial);
    let loads = 0;
    const runtime = create({
      sessionStore: {
        load: async (key) => {
          if (++loads === 2) {
            throw new Error("SDK record lookup failed");
          }
          return await store.load(key);
        },
        save: (record) => store.save(record),
      },
    });
    await expect(runtime.ensureSession(admissionInput)).rejects.toThrow("SDK record lookup failed");
    const handle = await runtime.ensureSession(admissionInput);
    expect(handle.backendSessionId).toBe(existing.backendSessionId);
    expect(await readContext(runtime, handle)).toMatchObject({
      sessionId: existing.backendSessionId,
    });
  });
}, 25_000);

it("retains failed private-runtime cleanup for service shutdown", async () => {
  await withFixture(async ({ create }) => {
    const cleanupAttempted = createDeferred<void>();
    const cleanupError = new Error("private runtime cleanup uncertain");
    let shutdown: MockInstance<() => Promise<void>> | undefined;
    let firstCleanup: Promise<void> | undefined;
    const runtime = create({
      processLifecycle: {
        onBeforeSpawn: async () => {
          const generation = acpxOperationScope.getStore()?.generation;
          if (!generation?.delegate) {
            throw new Error("missing private admission runtime");
          }
          expect(generation.afterReset).toBe(true);
          shutdown = vi.spyOn(generation.delegate, "shutdown").mockImplementationOnce(() => {
            firstCleanup = Promise.reject(cleanupError);
            cleanupAttempted.resolve();
            return firstCleanup;
          });
          throw new Error("launch failed before admission");
        },
      },
    });
    await runtime.prepareFreshSession(admissionTarget);
    await expect(runtime.ensureSession(admissionInput)).rejects.toThrow(
      "launch failed before admission",
    );
    await cleanupAttempted.promise;
    await expect(firstCleanup).rejects.toBe(cleanupError);
    expect(shutdown).toHaveBeenCalledOnce();
    await runtime.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(2);
  });
}, 25_000);

it("keeps a pending persisted-handle config snapshot through a failed ensure", async () => {
  await withFixture(async ({ runtime: initial, create, store, state }) => {
    const handle = await persistedHandle(initial);
    const registry = ownerRuntimeOptions(state.root).agentRegistry;
    const snapshot = createHeldCall(store.load.bind(store));
    let holdFirstRead = true;
    let failAdmission = false;
    const runtime = create({
      agentRegistry: {
        resolve: (agent) => {
          if (failAdmission && agent === admissionInput.agent) {
            failAdmission = false;
            throw new Error("concurrent admission preparation failed");
          }
          return registry.resolve(agent);
        },
        list: () => registry.list(),
      },
      sessionStore: {
        load: async (key) => {
          if (holdFirstRead) {
            holdFirstRead = false;
            return snapshot.call(key);
          }
          return await store.load(key);
        },
        save: (record) => store.save(record),
      },
    });
    const operation = runtime.setConfigOption({ handle, key: "tone", value: "brief" });
    void operation.catch(() => {});
    await atGate(snapshot, [operation], undefined, async () => {
      failAdmission = true;
      await expect(runtime.ensureSession(admissionInput)).rejects.toThrow(
        "concurrent admission preparation failed",
      );
      snapshot.release();
      await operation;
      expect(await readContext(runtime, handle)).toMatchObject({
        sessionId: handle.backendSessionId,
        tone: "brief",
      });
    });
  });
}, 25_000);

const resetSessionKey = "agent:codex:acp:binding:test";
const resetHandle = {
  sessionKey: resetSessionKey,
  backend: "acpx",
  runtimeSessionName: resetSessionKey,
};
const freshRecord = {
  acpxRecordId: resetSessionKey,
  name: resetSessionKey,
  acpSessionId: "fresh-session",
};

function makePersistedRuntime(acpxRecordId = resetSessionKey) {
  const oldRecord: Record<string, unknown> = {
    acpxRecordId,
    name: resetSessionKey,
    acpSessionId: "old-session",
  };
  const baseStore = makeSessionStore(oldRecord);
  return { ...makeRuntime(baseStore), baseStore, oldRecord };
}

async function ensureFresh(
  { runtime, baseStore, ensure }: ReturnType<typeof makeManagedRuntime>,
  handle: Awaited<ReturnType<typeof ensure>>,
  id: string,
) {
  const wrappedStore: AcpSessionStore = Reflect.get(runtime, "sessionStore");
  const record = { ...(await baseStore.load()), acpSessionId: id, closed: false };
  const create = vi
    .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
    .mockImplementationOnce(async () => {
      await wrappedStore.save(record);
      return { ...handle, backendSessionId: id };
    });
  try {
    const next = await ensure();
    const delegate = create.mock.contexts[0];
    if (!(delegate instanceof BaseAcpxRuntime)) {
      throw new Error("Fresh session did not use an ACPX runtime");
    }
    return { handle: next, delegate };
  } finally {
    create.mockRestore();
  }
}

async function resetRuntime(id: string) {
  const fixture = makeManagedRuntime();
  const previous = await fixture.ensure();
  const original = Reflect.get(fixture.runtime, "delegate") as BaseAcpxRuntime;
  await fixture.runtime.prepareFreshSession(fixture.target);
  return { ...fixture, original, ...(await ensureFresh(fixture, previous, id)) };
}

describe("AcpxRuntime reset generation custody", () => {
  it("fences persistence from a runtime option that finishes after reset", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } =
      makePersistedRuntime("old-record");
    const mode = createHeldCall(() => wrappedStore.save({ ...oldRecord, sessionMode: "stale" }));
    vi.spyOn(delegate, "setMode").mockImplementation(mode.call);
    const pending = runtime.setMode({ handle: resetHandle, mode: "stale" });
    await atGate(mode, [pending], runtime, async () => {
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save({ ...freshRecord, acpxRecordId: "fresh-record" });
      mode.release();
      await pending;
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    });
  });

  it.each(["startup", "control"])(
    "does not retry a model reference after reset during %s rejection",
    async (operation) => {
      const sessionKey = "agent:catalog:acp:model-reset";
      const { runtime, delegate } = makeRuntime(makeEmptySessionStore());
      const rejectedModel = createHeldCall(async (): Promise<never> => {
        throw new RequestedModelUnsupportedError("Model is not advertised", "unadvertised-model");
      });
      const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(rejectedModel.call);
      const control = vi.spyOn(delegate, "setConfigOption").mockImplementation(rejectedModel.call);
      const pending =
        operation === "startup"
          ? runtime.ensureSession({
              sessionKey,
              agent: "catalog",
              mode: "persistent",
              model: "provider/model",
              modelExplicit: true,
            })
          : runtime.setConfigOption({
              handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
              key: "model",
              value: "provider/model",
            });
      const rejected = expect(pending).rejects.toThrow("superseded by reset");
      await atGate(rejectedModel, [pending], runtime, async () => {
        await runtime.prepareFreshSession({ sessionKey });
        rejectedModel.release();
        await rejected;
        expect(operation === "startup" ? ensure : control).toHaveBeenCalledOnce();
      });
    },
  );

  it("keeps a fresh generation owned when an older discard close finishes late", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } = makePersistedRuntime();
    const closingRecord = createHeldCall(async () => {
      expect(await wrappedStore.load(resetSessionKey)).toBe(oldRecord);
      oldRecord.closed = true;
      oldRecord.acpx = { reset_on_next_ensure: true };
      await wrappedStore.save(oldRecord);
    });
    vi.spyOn(delegate, "close").mockImplementation(closingRecord.call);
    const input = {
      handle: resetHandle,
      reason: "new-in-place-reset",
      discardPersistentState: true,
    };
    const closing = runtime.close(input);
    await atGate(closingRecord, [closing], runtime, async () => {
      expect(await wrappedStore.load(resetSessionKey)).toBeUndefined();
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save(freshRecord);
      closingRecord.release();
      await closing;
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
      expect(await wrappedStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    });
  });

  it("preserves persisted session ownership after close persistence fails", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const handle = await ensure();
    baseStore.save.mockRejectedValueOnce(new Error("close failed"));
    await expect(runtime.close({ handle, reason: "closed" })).rejects.toThrow("close failed");
    expect((await baseStore.load()).closed).toBe(false);
    const next = await ensure();
    expect(next).toMatchObject({ ...target, backendSessionId: handle.backendSessionId });
    await runtime.close({ handle: next, reason: "closed" });
    await runtime.shutdown();
  });

  it("keeps successor persistence when overlapping post-reset closes settle", async () => {
    const fixture = await resetRuntime("prior-reset-session");
    const { runtime, target, baseStore, handle } = fixture;
    const save = createHeldCall(baseStore.save.getMockImplementation()!);
    baseStore.save.mockImplementationOnce(save.call);
    const firstClose = runtime.close({ handle, reason: "older close" });
    const pending: Promise<unknown>[] = [firstClose];
    await atGate(save, pending, undefined, async () => {
      const secondClose = runtime.close({ handle, reason: "concurrent close" });
      pending.push(secondClose);
      await runtime.prepareFreshSession(target);
      const successor = ensureFresh(fixture, handle, "successor-session");
      // The storage writer remains serialized, but the retired runtime does
      // not own the successor's queue or the final persisted session.
      save.release();
      const { handle: next } = await successor;
      await Promise.all([firstClose, secondClose]);
      expect(next.backendSessionId).toBe("successor-session");
      expect(await baseStore.load()).toMatchObject({
        acpSessionId: "successor-session",
        closed: false,
      });
      await runtime.close({ handle: next, reason: "final close" });
      await runtime.shutdown();
    });
  });
  it("keeps ordinary close and reopen off the blocked pre-reset runtime", async () => {
    const {
      runtime,
      ensure,
      original,
      handle: successor,
      delegate: successorRuntime,
    } = await resetRuntime("isolated-successor");
    const shutdown = vi.spyOn(successorRuntime, "shutdown");
    const blocked = vi
      .spyOn(original, "ensureSession")
      .mockRejectedValue(new Error("pre-reset runtime is still blocked"));
    try {
      await runtime.close({ handle: successor, reason: "ordinary close" });
      expect(shutdown).toHaveBeenCalledOnce();
      await shutdown.mock.results[0]!.value;
      const reopened = await ensure();
      expect(reopened.backendSessionId).toBe(successor.backendSessionId);
      expect(blocked).not.toHaveBeenCalled();
      await runtime.close({ handle: reopened, reason: "final close" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not allocate a reset runtime after shutdown during a close snapshot", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const previous = await ensure();
    await runtime.prepareFreshSession(target);
    // A persisted handle has no process-local generation symbol.
    const handle = {
      ...target,
      backend: previous.backend,
      runtimeSessionName: previous.runtimeSessionName,
      backendSessionId: previous.backendSessionId,
    };
    const record = await baseStore.load();
    const snapshot = createHeldCall(async () => record);
    baseStore.load.mockImplementationOnce(snapshot.call);
    const close = vi.spyOn(BaseAcpxRuntime.prototype, "close");
    const closing = runtime.close({ handle, reason: "discard", discardPersistentState: true });
    void closing.catch(() => {});
    await atGate(snapshot, [closing], runtime, async () => {
      await runtime.shutdown();
      snapshot.release();
      await expect(closing).rejects.toThrow("ACP runtime is shut down");
      expect(close).not.toHaveBeenCalled();
    });
  });

  it("waits for every post-reset runtime during service shutdown and rejects new work", async () => {
    const {
      runtime,
      ensure,
      delegate: successorRuntime,
    } = await resetRuntime("shutdown-successor");
    const successorShutdown = createTestGate();
    const shutdown = vi
      .spyOn(BaseAcpxRuntime.prototype, "shutdown")
      .mockImplementation(async function (this: BaseAcpxRuntime) {
        if (this === successorRuntime) {
          await successorShutdown.hold();
        }
      });
    let settled = false;
    const closing = runtime.shutdown().then(() => {
      settled = true;
    });
    try {
      await Promise.race([
        successorShutdown.entered,
        closing.then(() => {
          throw new Error("Shutdown settled before reaching the successor runtime");
        }),
      ]);
      expect(settled).toBe(false);
      await expect(ensure()).rejects.toThrow("ACP runtime is shut down");
      successorShutdown.release();
      await closing;
      expect(shutdown).toHaveBeenCalledTimes(2);
    } finally {
      successorShutdown.release();
      await closing;
    }
  });
});

it.each(["initial", "after-reset"])(
  "collects unused %s session owners while the runtime remains usable",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(admissionRetentionEntrypoint)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
