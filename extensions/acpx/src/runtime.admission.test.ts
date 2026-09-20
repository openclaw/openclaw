import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { acpxOperationScope } from "./runtime-session-store.js";
import {
  AcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpSessionStore,
} from "./runtime.js";

type RuntimeOptions = ConstructorParameters<typeof AcpxRuntime>[0];
type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
const peer = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));
const target = { sessionKey: "admission-project", agentId: "main" };
const input = { ...target, agent: "fixture", mode: "persistent" as const };

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
    const first = runtime.ensureSession(input);
    const rejected = expect(first).rejects.toThrow("first launch failed");
    let second: Promise<RuntimeHandle> | undefined;
    try {
      await started.promise;
      second = runtime.ensureSession(input);
      release.resolve();
      await rejected;
      const handle = await second;
      expect(generationIds).toHaveLength(2);
      expect(generationIds[1]).toBe(generationIds[0]);
      expect(await readContext(runtime, handle)).toMatchObject({
        mcpServers: [
          {
            name: "openclaw-tools",
            env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: target.sessionKey }],
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

it("keeps an admitted handle usable after a later ensure fails", async () => {
  await withFixture(async (options, store) => {
    let failLoad = false;
    const runtime = new AcpxRuntime({
      ...options,
      sessionStore: {
        load: async (key) => {
          if (failLoad) {
            failLoad = false;
            throw new Error("transient store read failure");
          }
          return await store.load(key);
        },
        save: (record) => store.save(record),
      },
    });
    try {
      const handle = await runtime.ensureSession(input);
      failLoad = true;
      await expect(runtime.ensureSession(input)).rejects.toThrow("transient store read failure");
      expect(await readContext(runtime, handle)).toMatchObject({
        sessionId: handle.backendSessionId,
      });
      expect((await runtime.ensureSession(input)).backendSessionId).toBe(handle.backendSessionId);
    } finally {
      await runtime.shutdown();
    }
  });
}, 25_000);

it("retains captured stored-record custody when admission later fails", async () => {
  await withFixture(async (options, store) => {
    const prior = new AcpxRuntime(options);
    let existing: RuntimeHandle;
    try {
      existing = await prior.ensureSession(input);
    } finally {
      await prior.shutdown();
    }
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
      await expect(runtime.ensureSession(input)).rejects.toThrow("SDK record lookup failed");
      const handle = await runtime.ensureSession(input);
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
      await runtime.prepareFreshSession(target);
      await expect(runtime.ensureSession(input)).rejects.toThrow("launch failed before admission");
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

it.each([
  {
    name: "getStatus",
    run: (runtime: AcpxRuntime, handle: RuntimeHandle) => runtime.getStatus({ handle }),
    expected: {},
  },
  {
    name: "setMode",
    run: (runtime: AcpxRuntime, handle: RuntimeHandle) =>
      runtime.setMode({ handle, mode: "review" }),
    expected: { mode: "review" },
  },
  {
    name: "setConfigOption",
    run: (runtime: AcpxRuntime, handle: RuntimeHandle) =>
      runtime.setConfigOption({ handle, key: "tone", value: "brief" }),
    expected: { tone: "brief" },
  },
  {
    name: "cancel",
    run: (runtime: AcpxRuntime, handle: RuntimeHandle) =>
      runtime.cancel({ handle, reason: "test" }),
    expected: {},
  },
  { name: "startTurn", run: readContext, expected: {} },
])(
  "keeps a pending persisted-handle $name snapshot through a failed ensure",
  async ({ run, expected }) => {
    await withFixture(async (options, store) => {
      const prior = new AcpxRuntime(options);
      let handle: RuntimeHandle;
      try {
        handle = await prior.ensureSession(input);
      } finally {
        await prior.shutdown();
      }
      const snapshotStarted = createDeferred<void>();
      const releaseSnapshot = createDeferred<void>();
      let holdFirstRead = true;
      let failAdmission = false;
      const runtime = new AcpxRuntime({
        ...options,
        agentRegistry: {
          resolve: (agent) => {
            if (failAdmission && agent === input.agent) {
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
      const operation = run(runtime, handle);
      const outcome = operation.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      try {
        await snapshotStarted.promise;
        failAdmission = true;
        await expect(runtime.ensureSession(input)).rejects.toThrow(
          "concurrent admission preparation failed",
        );
        releaseSnapshot.resolve();
        const result = await outcome;
        if (result.kind === "failed") {
          throw result.error;
        }
        expect(await readContext(runtime, handle)).toMatchObject({
          sessionId: handle.backendSessionId,
          ...expected,
        });
      } finally {
        releaseSnapshot.resolve();
        await outcome;
        await runtime.shutdown();
      }
    });
  },
  25_000,
);
