import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AcpxRuntime as BaseAcpxRuntime,
  RequestedModelUnsupportedError,
  createAgentRegistry,
  createFileSessionStore,
  type AcpSessionStore,
} from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpxOperationScope } from "./runtime-session-store.js";
import { admissionRetentionEntrypoint } from "./runtime.admission-retention-entrypoint.test-support.js";
import { AcpxRuntime } from "./runtime.js";
import { type TestSessionStore, makeRuntime, makeManagedRuntime } from "./runtime.test-support.js";

type RuntimeOptions = ConstructorParameters<typeof AcpxRuntime>[0];
type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));
const admissionTarget = { sessionKey: "admission-project", agentId: "main" };
const admissionInput = { ...admissionTarget, agent: "fixture", mode: "persistent" as const };

afterEach(() => vi.restoreAllMocks());

async function withFixture(
  run: (options: RuntimeOptions, store: AcpSessionStore) => Promise<void>,
) {
  await withOpenClawTestState({ label: "acpx-admission" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const store = createFileSessionStore({ stateDir: state.root });
    await run(
      {
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({
          overrides: { fixture: [process.execPath, peer, directory] },
        }),
        openclawToolsMcpBridgeEnabled: true,
        mcpServers: [{ name: "openclaw-tools", command: process.execPath, args: [], env: [] }],
        permissionMode: "deny-all",
        timeoutMs: 5000,
      },
      store,
    );
  });
}

async function persistedHandle(options: RuntimeOptions) {
  const runtime = new AcpxRuntime(options);
  try {
    return await runtime.ensureSession(admissionInput);
  } finally {
    await runtime.shutdown();
  }
}

async function readContext(runtime: AcpxRuntime, handle: RuntimeHandle): Promise<unknown> {
  const turn = runtime.startTurn({
    handle,
    text: "show context",
    mode: "prompt",
    requestId: "admission-proof",
  });
  const events = (async () => {
    let text = "";
    for await (const event of turn.events) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }
    return text;
  })();
  const [result, text] = await Promise.all([turn.result, events]);
  expect(result).toMatchObject({ status: "completed" });
  return JSON.parse(text);
}

it("preserves a queued same-key admission when its predecessor fails", async () => {
  await withFixture(async (options) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const generationIds: number[] = [];
    const runtime = new AcpxRuntime({
      ...options,
      processLifecycle: {
        onBeforeSpawn: async () => {
          const generation = acpxOperationScope.getStore()?.generation;
          if (!generation) {
            throw new Error("missing admission owner");
          }
          generationIds.push(generation.id);
          if (generationIds.length === 1) {
            started.resolve();
            await release.promise;
            throw new Error("first launch failed");
          }
        },
      },
    });
    const first = runtime.ensureSession(admissionInput);
    const rejected = expect(first).rejects.toThrow("first launch failed");
    let second: Promise<RuntimeHandle> | undefined;
    try {
      await started.promise;
      second = runtime.ensureSession(admissionInput);
      release.resolve();
      await rejected;
      const handle = await second;
      expect(generationIds).toHaveLength(2);
      expect(generationIds[1]).toBe(generationIds[0]);
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
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await runtime.shutdown();
    }
  });
}, 25_000);

it("retains captured stored-record custody when admission later fails", async () => {
  await withFixture(async (options, store) => {
    const existing = await persistedHandle(options);
    const generationIds: number[] = [];
    let loads = 0;
    const runtime = new AcpxRuntime({
      ...options,
      sessionStore: {
        load: async (key) => {
          const generation = acpxOperationScope.getStore()?.generation;
          if (generation) {
            generationIds.push(generation.id);
          }
          if (++loads === 2) {
            throw new Error("SDK record lookup failed");
          }
          return await store.load(key);
        },
        save: (record) => store.save(record),
      },
    });
    try {
      await expect(runtime.ensureSession(admissionInput)).rejects.toThrow(
        "SDK record lookup failed",
      );
      const handle = await runtime.ensureSession(admissionInput);
      expect(generationIds.length).toBeGreaterThanOrEqual(4);
      expect(new Set(generationIds).size).toBe(1);
      expect(handle.backendSessionId).toBe(existing.backendSessionId);
      expect(await readContext(runtime, handle)).toMatchObject({
        sessionId: existing.backendSessionId,
      });
    } finally {
      await runtime.shutdown();
    }
  });
}, 25_000);

it("retains failed private-runtime cleanup for service shutdown", async () => {
  await withFixture(async (options) => {
    const cleanupAttempted = createDeferred<void>();
    const cleanupError = new Error("private runtime cleanup uncertain");
    let shutdownAttempts = 0;
    let firstCleanup: Promise<void> | undefined;
    const runtime = new AcpxRuntime({
      ...options,
      processLifecycle: {
        onBeforeSpawn: async () => {
          const generation = acpxOperationScope.getStore()?.generation;
          if (!generation?.delegate) {
            throw new Error("missing private admission runtime");
          }
          expect(generation.afterReset).toBe(true);
          const shutdown = generation.delegate.shutdown.bind(generation.delegate);
          vi.spyOn(generation.delegate, "shutdown").mockImplementation(() => {
            shutdownAttempts += 1;
            if (shutdownAttempts === 1) {
              firstCleanup = Promise.reject(cleanupError);
              cleanupAttempted.resolve();
              return firstCleanup;
            }
            return shutdown();
          });
          throw new Error("launch failed before admission");
        },
      },
    });
    try {
      await runtime.prepareFreshSession(admissionTarget);
      await expect(runtime.ensureSession(admissionInput)).rejects.toThrow(
        "launch failed before admission",
      );
      await cleanupAttempted.promise;
      await expect(firstCleanup).rejects.toBe(cleanupError);
      expect(shutdownAttempts).toBe(1);
      await runtime.shutdown();
      expect(shutdownAttempts).toBe(2);
    } finally {
      await runtime.shutdown();
    }
  });
}, 25_000);

it("keeps a pending persisted-handle config snapshot through a failed ensure", async () => {
  await withFixture(async (options, store) => {
    const handle = await persistedHandle(options);
    const snapshotStarted = createDeferred<void>();
    const releaseSnapshot = createDeferred<void>();
    let holdFirstRead = true;
    let failAdmission = false;
    const runtime = new AcpxRuntime({
      ...options,
      agentRegistry: {
        resolve: (agent) => {
          if (failAdmission && agent === admissionInput.agent) {
            failAdmission = false;
            throw new Error("concurrent admission preparation failed");
          }
          return options.agentRegistry.resolve(agent);
        },
        list: () => options.agentRegistry.list(),
      },
      sessionStore: {
        load: async (key) => {
          if (holdFirstRead) {
            holdFirstRead = false;
            snapshotStarted.resolve();
            await releaseSnapshot.promise;
          }
          return await store.load(key);
        },
        save: (record) => store.save(record),
      },
    });
    const operation = runtime.setConfigOption({ handle, key: "tone", value: "brief" });
    void operation.catch(() => {});
    try {
      await snapshotStarted.promise;
      failAdmission = true;
      await expect(runtime.ensureSession(admissionInput)).rejects.toThrow(
        "concurrent admission preparation failed",
      );
      releaseSnapshot.resolve();
      await operation;
      expect(await readContext(runtime, handle)).toMatchObject({
        sessionId: handle.backendSessionId,
        tone: "brief",
      });
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([operation]);
      await runtime.shutdown();
    }
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
  let persisted = oldRecord;
  const baseStore = {
    load: vi.fn<TestSessionStore["load"]>(async () => persisted),
    save: vi.fn<TestSessionStore["save"]>(async (record) => {
      persisted = record;
    }),
  };
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

describe("AcpxRuntime reset generation custody", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("fences persistence from a runtime option that finishes after reset", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } =
      makePersistedRuntime("old-record");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      await wrappedStore.save({ ...oldRecord, sessionMode: "stale" });
    });
    const pending = runtime.setMode({ handle: resetHandle, mode: "stale" });
    try {
      await started.promise;
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save({ ...freshRecord, acpxRecordId: "fresh-record" });
      release.resolve();
      await pending;
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      await runtime.shutdown();
    }
  });

  it.each(["startup", "control"])(
    "does not retry a model reference after reset during %s rejection",
    async (operation) => {
      const sessionKey = "agent:catalog:acp:model-reset";
      const { runtime, delegate } = makeRuntime({
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => {}),
      });
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const rejectModel = async (): Promise<never> => {
        started.resolve();
        await release.promise;
        throw new RequestedModelUnsupportedError("Model is not advertised", "unadvertised-model");
      };
      const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(rejectModel);
      const control = vi.spyOn(delegate, "setConfigOption").mockImplementation(rejectModel);
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
      try {
        await started.promise;
        await runtime.prepareFreshSession({ sessionKey });
        release.resolve();
        await rejected;
        expect(operation === "startup" ? ensure : control).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        await runtime.shutdown();
      }
    },
  );

  it("keeps a fresh generation owned when an older discard close finishes late", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } = makePersistedRuntime();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const close = vi.spyOn(delegate, "close").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      expect(await wrappedStore.load(resetSessionKey)).toBe(oldRecord);
      oldRecord.closed = true;
      oldRecord.acpx = { reset_on_next_ensure: true };
      await wrappedStore.save(oldRecord);
    });
    const input = {
      handle: resetHandle,
      reason: "new-in-place-reset",
      discardPersistentState: true,
    };
    const closing = runtime.close(input);
    try {
      await started.promise;
      expect(close).toHaveBeenCalledExactlyOnceWith(input);
      expect(await wrappedStore.load(resetSessionKey)).toBeUndefined();
      expect(baseStore.load).toHaveBeenCalledOnce();
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save(freshRecord);
      release.resolve();
      await closing;
      expect(baseStore.load).toHaveBeenCalledTimes(2);
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
      expect(await wrappedStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([closing]);
      await runtime.shutdown();
    }
  });

  it("preserves persisted session ownership after close persistence fails", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const handle = await ensure();
    baseStore.save.mockRejectedValueOnce(new Error("close failed"));
    await expect(runtime.close({ handle, reason: "closed" })).rejects.toThrow("close failed");
    expect((await baseStore.load()).closed).toBe(false);
    const next = await ensure();
    expect(next.sessionKey).toBe(target.sessionKey);
    expect(next.agentId).toBe(target.agentId);
    expect(next.backendSessionId).toBe(handle.backendSessionId);
    await runtime.close({ handle: next, reason: "closed" });
    await runtime.shutdown();
  });

  it("keeps successor persistence when overlapping post-reset closes settle", async () => {
    const fixture = makeManagedRuntime();
    const { runtime, target, baseStore, ensure } = fixture;
    let handle = await ensure();
    await runtime.prepareFreshSession(target);
    handle = (await ensureFresh(fixture, handle, "prior-reset-session")).handle;
    const closingStarted = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    const save = baseStore.save.getMockImplementation()!;
    baseStore.save.mockImplementationOnce(async (record) => {
      closingStarted.resolve();
      await releaseClose.promise;
      await save(record);
    });
    const firstClose = runtime.close({ handle, reason: "older close" });
    let secondClose: Promise<void> | undefined;
    try {
      await closingStarted.promise;
      secondClose = runtime.close({ handle, reason: "concurrent close" });
      await runtime.prepareFreshSession(target);
      const successor = ensureFresh(fixture, handle, "successor-session");
      // The storage writer remains serialized, but the retired runtime does
      // not own the successor's queue or the final persisted session.
      releaseClose.resolve();
      const { handle: next } = await successor;
      await Promise.all([firstClose, secondClose]);
      expect(next.backendSessionId).toBe("successor-session");
      expect((await baseStore.load()).acpSessionId).toBe("successor-session");
      expect((await baseStore.load()).closed).toBe(false);
      await runtime.close({ handle: next, reason: "final close" });
      await runtime.shutdown();
    } finally {
      releaseClose.resolve();
      await Promise.allSettled([firstClose, ...(secondClose ? [secondClose] : [])]);
    }
  });
  it("keeps ordinary close and reopen off the blocked pre-reset runtime", async () => {
    const fixture = makeManagedRuntime();
    const { runtime, target, ensure } = fixture;
    const handle = await ensure();
    const original = Reflect.get(runtime, "delegate") as BaseAcpxRuntime;
    await runtime.prepareFreshSession(target);
    const { handle: successor, delegate: successorRuntime } = await ensureFresh(
      fixture,
      handle,
      "isolated-successor",
    );
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
    const snapshotStarted = createDeferred<void>();
    const releaseSnapshot = createDeferred<void>();
    baseStore.load.mockImplementationOnce(async () => {
      snapshotStarted.resolve();
      await releaseSnapshot.promise;
      return record;
    });
    const close = vi.spyOn(BaseAcpxRuntime.prototype, "close");
    const closing = runtime.close({ handle, reason: "discard", discardPersistentState: true });
    void closing.catch(() => {});
    try {
      await snapshotStarted.promise;
      await runtime.shutdown();
      releaseSnapshot.resolve();
      await expect(closing).rejects.toThrow("ACP runtime is shut down");
      expect(close).not.toHaveBeenCalled();
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([closing]);
      await runtime.shutdown();
    }
  });

  it("waits for every post-reset runtime during service shutdown and rejects new work", async () => {
    const fixture = makeManagedRuntime();
    const { runtime, target, ensure } = fixture;
    const handle = await ensure();
    await runtime.prepareFreshSession(target);
    const { delegate: successorRuntime } = await ensureFresh(fixture, handle, "shutdown-successor");
    const successorShutdownStarted = createDeferred<void>();
    const releaseShutdown = createDeferred<void>();
    const shutdown = vi
      .spyOn(BaseAcpxRuntime.prototype, "shutdown")
      .mockImplementation(async function (this: BaseAcpxRuntime) {
        if (this === successorRuntime) {
          successorShutdownStarted.resolve();
          await releaseShutdown.promise;
        }
      });
    let settled = false;
    const closing = runtime.shutdown().then(() => {
      settled = true;
    });
    try {
      await Promise.race([
        successorShutdownStarted.promise,
        closing.then(() => {
          throw new Error("Shutdown settled before reaching the successor runtime");
        }),
      ]);
      expect(settled).toBe(false);
      await expect(ensure()).rejects.toThrow("ACP runtime is shut down");
      releaseShutdown.resolve();
      await closing;
      expect(shutdown).toHaveBeenCalledTimes(2);
    } finally {
      releaseShutdown.resolve();
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
