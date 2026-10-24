import path from "node:path";
import { resolveBootstrapFilesForPreparation } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import {
  patchSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createParams,
  createTestParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  sessionBindingIdentity,
  resolveCodexSessionBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();

const webSearchThreadConfigFingerprint = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function existingBinding(cwd: string) {
  return {
    threadId: "thread-existing",
    cwd,
    dynamicToolsFingerprint: "[]",
    webSearchThreadConfigFingerprint,
    historyCoveredThrough: new Date(1).toISOString(),
  };
}

const superseded = { name: "AgentHarnessSessionSupersededError" };
const successful = { aborted: false, timedOut: false, promptError: null };
const settle = <T>(run: Promise<T>) =>
  run.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

async function beforeSettlement<T>(pending: Promise<unknown>, run: Promise<T>) {
  await Promise.race([
    pending,
    run.then(() => {
      throw new Error("Attempt settled before the expected lifecycle boundary");
    }),
  ]);
}

async function generationFixture(predecessor?: string) {
  const params = createTestParams();
  const current = sessionBindingIdentity(params);
  const previous = { ...current, sessionId: predecessor ?? current.sessionId };
  const scope = {
    agentId: current.agentId,
    sessionKey: params.sessionKey!,
    storePath: path.join(tempDir, "admitted", "sessions.json"),
  };
  params.sessionTarget = { ...scope, sessionId: current.sessionId };
  await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
  if (predecessor) {
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
  }
  const bindingStore = createCodexTestBindingStore();
  await bindingStore.mutate(previous, {
    kind: "set",
    binding: existingBinding(params.workspaceDir),
  });
  return { params, current, scope, bindingStore };
}

async function prepareGenerationAttempt(params: ReturnType<typeof createParams>) {
  await resolveBootstrapFilesForPreparation({ ...params, agentId: "main" });
  await readMirroredSessionHistoryMessages({ ...params, agentId: "main" });
  await getSharedCodexAppServerClient({
    startOptions: {
      transport: "stdio",
      command: process.execPath,
      args: ["app-server"],
      headers: {},
    },
    agentDir: path.join(tempDir, "wire-agent"),
    authProfileId: null,
    config: {},
  });
}

it.each([true, false])(
  "rejects superseded generations before startup (supervision=%s)",
  async (supervision) => {
    const params = createTestParams();
    const { sessionFile, workspaceDir } = params;
    const sessionKey = params.sessionKey!;
    const boundSessionId = supervision ? "session-previous" : "session-durable-current";
    params.sessionId = supervision ? "session-current" : "session-durable-stale";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "durable-state"));
    const storePath = supervision
      ? path.join(tempDir, "sessions.json")
      : resolveStorePath(undefined, { agentId: "main" });
    const pluginConfig = { supervision: { enabled: true } };
    registerCodexTestSessionIdentity(sessionFile, boundSessionId, sessionKey);
    await writeCodexAppServerBinding(
      sessionFile,
      supervision
        ? {
            threadId: "thread-existing",
            cwd: workspaceDir,
            connectionScope: "supervision",
            supervisionSourceThreadId: "thread-source",
            model: "gpt-5.5",
            modelProvider: "openai",
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
          }
        : { threadId: "thread-durable-current", cwd: workspaceDir },
    );
    await upsertSessionEntry({
      storePath,
      sessionKey,
      ...(supervision ? {} : { agentId: "main" }),
      entry: {
        sessionId: supervision ? params.sessionId : boundSessionId,
        updatedAt: Date.now(),
      },
    });
    if (supervision) {
      params.config = { session: { store: storePath } };
      setRuntimeConfigSnapshot(params.config);
    }
    const clientFactory = vi.fn(async () => {
      throw new Error("client must not start");
    });
    await expect(
      runCodexAppServerAttempt(params, {
        clientFactory,
        ...(supervision ? { pluginConfig } : {}),
      }),
    ).rejects.toMatchObject({
      ...superseded,
      message: `Codex session generation is no longer current: ${params.sessionId}`,
    });
    expect(clientFactory).not.toHaveBeenCalled();
    if (supervision) {
      registerCodexTestSessionIdentity(sessionFile, boundSessionId, sessionKey);
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-existing",
        connectionScope: "supervision",
      });
    }
  },
);

it("starts sequential ephemeral generations with the default session store", async () => {
  const sessionKey = "agent:main:ephemeral-helper";
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "ephemeral-state"));
  let generation = 0;
  let turnStarted = createDeferred<void>();
  const harness = createStartedThreadHarness(async (method) => {
    if (method === "thread/start") {
      generation += 1;
      return threadStartResult(`thread-ephemeral-${generation}`);
    }
    if (method === "turn/start") {
      turnStarted.resolve();
      return turnStartResult(`turn-ephemeral-${generation}`);
    }
    return undefined;
  });

  for (const expectedGeneration of [1, 2]) {
    const params = createTestParams();
    params.sessionId = `session-ephemeral-${expectedGeneration}`;
    params.sessionKey = sessionKey;
    turnStarted = createDeferred<void>();
    const run = runCodexAppServerAttempt(params);
    await beforeSettlement(turnStarted.promise, run);
    expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      expectedGeneration,
    );
    const threadId = `thread-ephemeral-${expectedGeneration}`;
    const turnId = `turn-ephemeral-${expectedGeneration}`;
    await harness.completeTurn({ threadId, turnId });
    expect(readAttemptTerminal(await run)).toMatchObject(successful);
  }
  expect(harness.requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
});
it.each(["current", "lineage-replaced"] as const)(
  "uses worker authority at the originating turn/start wire boundary (%s)",
  async (generation) => {
    const { params, scope, bindingStore } = await generationFixture();
    // Authority assertions do not spend their attempt budget on worker preparation.
    vi.useFakeTimers({ toFake: ["Date"] });
    const harness = createResumeHarness();
    if (!("writes" in harness)) {
      throw new Error("expected the persisted-thread app-server harness");
    }
    await prepareGenerationAttempt(params);
    const originalRequest = harness.request.getMockImplementation()!;
    const entered = createDeferred<void>();
    harness.request.mockImplementation(async (...args: Parameters<typeof originalRequest>) => {
      const [method, request, options] = args;
      if (method !== "turn/start") {
        return await originalRequest(...args);
      }
      expect(options?.withCurrent).toBeTypeOf("function");
      const withCurrent = options!.withCurrent!;
      return await originalRequest(method, request, {
        ...options,
        withCurrent: async (write) => {
          entered.resolve();
          if (generation === "lineage-replaced") {
            await patchSessionEntry({
              ...scope,
              update: () => ({ previousSessionId: "same-id-new-predecessor" }),
            });
          }
          await withCurrent(() => {
            const forbidden = vi
              .spyOn(sessionStoreRuntime, "getSessionEntry")
              .mockImplementation(() => {
                throw new Error("synchronous host lineage read reached wire admission");
              });
            try {
              write();
            } finally {
              forbidden.mockRestore();
            }
          });
        },
      });
    });
    const run = runCodexAppServerAttempt(params, { bindingStore });
    const settled = settle(run);
    try {
      await beforeSettlement(entered.promise, settled);
      if (generation === "current") {
        await harness.waitForMethod("turn/start");
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        expect(readAttemptTerminal(await run)).toMatchObject({
          promptError: null,
          aborted: false,
        });
      } else {
        await expect(settled).resolves.toMatchObject({
          error: superseded,
        });
        expect(harness.writes.some((line) => JSON.parse(line).method === "turn/start")).toBe(false);
      }
    } finally {
      harness.close();
      await settled;
    }
  },
);

it("preserves successor continuity after agent_end outlives the recovered generation", async () => {
  const {
    params,
    current,
    scope,
    bindingStore: baseStore,
  } = await generationFixture("before-compaction");
  const { sessionFile, workspaceDir } = params;
  const successor = { ...current, sessionId: "after-compaction" };
  const enteredAgentEnd = createDeferred<void>();
  const releaseAgentEnd = createDeferred<void>();
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "agent_end",
        handler: async (event) => {
          if (!isRecord(event) || !event.success) {
            return;
          }
          enteredAgentEnd.resolve();
          await releaseAgentEnd.promise;
        },
      },
    ]),
  );
  // This case controls generation handoff, including the awaited finalization tail.
  vi.useFakeTimers({ toFake: ["Date"] });
  const harness = createResumeHarness();
  await prepareGenerationAttempt(params);
  const run = runCodexAppServerAttempt(params, { bindingStore: baseStore });
  const settledRun = settle(run);
  try {
    await beforeSettlement(harness.waitForMethod("turn/start"), run);
    const admittedBinding = baseStore.read(current);
    expect(admittedBinding).toMatchObject({ threadId: "thread-existing" });
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await beforeSettlement(enteredAgentEnd.promise, run);
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
    const marker = "successor message never sent to the previous native turn";
    const timestamp = Date.now();
    expect(timestamp).toBeGreaterThan(Date.parse(admittedBinding!.historyCoveredThrough!));
    expect(
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        sessionId: successor.sessionId,
        message: { role: "user", content: marker, timestamp },
      }),
    ).toBeDefined();
    releaseAgentEnd.resolve();
    const outcome = await settledRun;

    expect(baseStore.read(current)).toEqual(admittedBinding);
    expect(outcome).toMatchObject({ error: superseded });
    const adopted = await resolveCodexSessionBinding({
      bindingStore: baseStore,
      identity: successor,
      storePath: scope.storePath,
    });
    using _ = { [Symbol.dispose]: adopted.release };
    expect(adopted.binding).toEqual(admittedBinding);
    harness.close();

    const nextHarness = createResumeHarness();
    const nextParams = createParams(sessionFile, workspaceDir, {
      sessionId: successor.sessionId,
      runId: "run-successor",
      prompt: "continue after compaction",
    });
    nextParams.sessionTarget = { ...scope, sessionId: successor.sessionId };
    await prepareGenerationAttempt(nextParams);
    const nextRun = runCodexAppServerAttempt(nextParams, { bindingStore: baseStore });
    await nextHarness.waitForMethod("turn/start");
    await nextHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    expect(readAttemptTerminal(await nextRun)).toMatchObject(successful);
    expect(
      nextHarness.requests.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      threadId: "thread-existing",
      input: [expect.objectContaining({ text: expect.stringContaining(marker) })],
    });
  } finally {
    releaseAgentEnd.resolve();
    await settledRun;
  }
});

it("clears a stale binding when completed-turn coverage persistence fails", async () => {
  const params = createTestParams();
  const harness = createStartedThreadHarness();
  const bindingStore = {
    ...testCodexAppServerBindingStore,
    mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
      const mutation = args[1];
      if (mutation.kind === "patch" && mutation.patch.historyCoveredThrough) {
        throw new Error("simulated binding coverage write failure");
      }
      return await testCodexAppServerBindingStore.mutate(...args);
    }),
  };
  const run = runCodexAppServerAttempt(params, { bindingStore });
  await harness.waitForMethod("turn/start");

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  expect(readAttemptTerminal(await run)).toMatchObject({ promptError: null, aborted: false });
  expect(bindingStore.mutate).toHaveBeenCalled();
  await expect(readCodexAppServerBinding(params.sessionFile)).resolves.toBeUndefined();
});
