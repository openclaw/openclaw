import assert from "node:assert/strict";
import path from "node:path";
import { resolveBootstrapFilesForPreparation } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  patchSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  createParams,
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
  resolveCodexSessionBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();

async function prepareGenerationAttempt(params: ReturnType<typeof createParams>) {
  await resolveBootstrapFilesForPreparation({
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: "main",
  });
  await readMirroredSessionHistoryMessages({
    agentId: "main",
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    contextTokenBudget: params.contextTokenBudget,
  });
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

describe("Codex generation admission", () => {
  it("fails before client startup when a successor generation hides a private supervision binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:supervised-stale-generation";
    registerCodexTestSessionIdentity(sessionFile, "session-previous", sessionKey);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      historyCoveredThrough: new Date().toISOString(),
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({
          pluginConfig: { supervision: { enabled: true } },
        }),
      ),
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const storePath = path.join(tempDir, "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-current",
        updatedAt: Date.now(),
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    params.sessionId = "session-current";
    params.sessionKey = sessionKey;
    params.config = { session: { store: storePath } };
    const clientFactory = vi.fn(async () => {
      throw new Error("client must not start");
    });
    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: { supervision: { enabled: true } },
        clientFactory,
      }),
    ).rejects.toMatchObject({
      name: "AgentHarnessSessionSupersededError",
      message: "Codex session generation is no longer current: session-current",
    });
    expect(clientFactory).not.toHaveBeenCalled();
    registerCodexTestSessionIdentity(sessionFile, "session-previous", sessionKey);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
    });
  });

  it.each(["default", "config", "target"] as const)(
    "starts sequential ephemeral generations with the %s session store",
    async (storeSelection) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const sessionKey = "agent:main:ephemeral-helper";
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "ephemeral-state"));
      const storePath = path.join(tempDir, "ephemeral-sessions.json");
      let generation = 0;
      const turnStarts = new Map<number, ReturnType<typeof createDeferred<void>>>();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start") {
          generation += 1;
          return threadStartResult(`thread-ephemeral-${generation}`);
        }
        if (method === "turn/start") {
          const started = turnStarts.get(generation);
          assert(started, "Unexpected Codex turn generation");
          started.resolve();
          return turnStartResult(`turn-ephemeral-${generation}`);
        }
        return undefined;
      });

      for (const [index, sessionId] of ["session-ephemeral-1", "session-ephemeral-2"].entries()) {
        const params = createParams(sessionFile, workspaceDir);
        params.sessionId = sessionId;
        params.sessionKey = sessionKey;
        if (storeSelection === "target") {
          params.sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
        } else if (storeSelection === "config") {
          params.config = { ...params.config, session: { store: storePath } };
        }

        const expectedGeneration = index + 1;
        const turnStarted = createDeferred<void>();
        turnStarts.set(expectedGeneration, turnStarted);
        const run = runCodexAppServerAttempt(params);
        const startup = await Promise.race([
          turnStarted.promise.then(() => ({ kind: "started" as const })),
          run.then((result) => ({ kind: "completed" as const, result })),
        ]);
        expect(startup).toMatchObject({ kind: "started" });
        expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
          expectedGeneration,
        );
        const threadId = `thread-ephemeral-${expectedGeneration}`;
        const turnId = `turn-ephemeral-${expectedGeneration}`;
        await harness.completeTurn({ threadId, turnId });
        expect(readAttemptTerminal(await run)).toMatchObject({
          aborted: false,
          timedOut: false,
          promptError: null,
        });
      }
      expect(harness.requests.filter((request) => request.method === "thread/start")).toHaveLength(
        2,
      );
    },
  );

  it.each(["default", "config", "target"] as const)(
    "rejects a superseded generation in the %s session store",
    async (storeSelection) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const sessionKey = "agent:main:durable-generation";
      const durableSessionId = "session-durable-current";
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "durable-state"));
      const storePath =
        storeSelection === "default"
          ? resolveStorePath(undefined, { agentId: "main" })
          : path.join(tempDir, "durable-sessions.json");
      registerCodexTestSessionIdentity(sessionFile, durableSessionId, sessionKey);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-durable-current",
        cwd: workspaceDir,
      });
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: { sessionId: durableSessionId, updatedAt: Date.now() },
      });
      const params = createParams(sessionFile, workspaceDir);
      params.sessionId = "session-durable-stale";
      params.sessionKey = sessionKey;
      if (storeSelection === "target") {
        params.sessionTarget = {
          agentId: "main",
          sessionId: params.sessionId,
          sessionKey,
          storePath,
        };
      } else if (storeSelection === "config") {
        params.config = { ...params.config, session: { store: storePath } };
      }
      const clientFactory = vi.fn(async () => {
        throw new Error("client must not start");
      });

      await expect(runCodexAppServerAttempt(params, { clientFactory })).rejects.toMatchObject({
        name: "AgentHarnessSessionSupersededError",
        message: "Codex session generation is no longer current: session-durable-stale",
      });
      expect(clientFactory).not.toHaveBeenCalled();
    },
  );
});

describe("Codex finalization generation ownership", () => {
  it.each([false, true])(
    "preserves successor continuity after agent_end outlives the recovered generation (coverage storage rejects: %s)",
    async (rejectCoverage) => {
      const sessionFile = path.join(tempDir, "generation-coverage.jsonl");
      const workspaceDir = path.join(tempDir, "generation-coverage-workspace");
      const params = createParams(sessionFile, workspaceDir);
      const current = {
        kind: "session" as const,
        agentId: "main",
        sessionKey: params.sessionKey!,
        sessionId: params.sessionId,
      };
      const previous = { ...current, sessionId: "before-compaction" };
      const successor = { ...current, sessionId: "after-compaction" };
      const scope = {
        agentId: current.agentId,
        sessionKey: current.sessionKey,
        storePath: path.join(tempDir, "admitted", "sessions.json"),
      };
      params.sessionTarget = { ...scope, sessionId: current.sessionId };
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: previous.sessionId, updatedAt: 1 },
      });
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
      const baseStore = createCodexTestBindingStore();
      await baseStore.mutate(previous, {
        kind: "set",
        binding: {
          threadId: "thread-existing",
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
          historyCoveredThrough: new Date(1).toISOString(),
        },
      });
      const bindingStore = {
        ...baseStore,
        mutate: async (...args: Parameters<typeof baseStore.mutate>) => {
          if (rejectCoverage && args[1].kind === "patch" && args[1].patch.historyCoveredThrough) {
            throw new Error("simulated binding coverage write failure");
          }
          return await baseStore.mutate(...args);
        },
      };
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
      const harness = createResumeHarness();
      await prepareGenerationAttempt(params);
      const run = runCodexAppServerAttempt(params, { bindingStore });
      const settledRun = run.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          harness.waitForMethod("turn/start"),
          run.then(() => {
            throw new Error("Codex turn settled before turn/start");
          }),
        ]);
        const admittedBinding = baseStore.read(current);
        expect(admittedBinding).toMatchObject({ threadId: "thread-existing" });
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await Promise.race([
          enteredAgentEnd.promise,
          settledRun.then((outcome) => {
            if ("error" in outcome) {
              throw outcome.error;
            }
            throw new Error("Codex turn settled before agent_end held finalization", {
              cause: {
                terminal: readAttemptTerminal(outcome.result),
                codexAppServerFailure: outcome.result.codexAppServerFailure,
              },
            });
          }),
        ]);
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
        expect(outcome).toMatchObject({ error: { name: "AgentHarnessSessionSupersededError" } });
        const adopted = await resolveCodexSessionBinding({
          bindingStore: baseStore,
          identity: successor,
          storePath: scope.storePath,
        });
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
        expect(readAttemptTerminal(await nextRun)).toMatchObject({
          promptError: null,
          aborted: false,
          timedOut: false,
        });
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
    },
  );

  it("clears a stale binding when completed-turn coverage persistence fails", async () => {
    const sessionFile = path.join(tempDir, "binding-coverage-failure.jsonl");
    const workspaceDir = path.join(tempDir, "binding-coverage-workspace");
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
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), { bindingStore });
    await harness.waitForMethod("turn/start");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ promptError: null, aborted: false });
    expect(bindingStore.mutate).toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("settles an explicitly aborted resumed attempt after native terminal cleanup", async () => {
    const sessionFile = path.join(tempDir, "resumed-abort.jsonl");
    const workspaceDir = path.join(tempDir, "resumed-abort-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const bindingStore = createCodexTestBindingStore();
    await bindingStore.mutate(
      {
        kind: "session",
        agentId: "main",
        sessionKey: params.sessionKey!,
        sessionId: params.sessionId,
      },
      {
        kind: "set",
        binding: {
          threadId: "thread-existing",
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
          historyCoveredThrough: new Date(1).toISOString(),
        },
      },
    );
    const harness = createResumeHarness();
    const run = runCodexAppServerAttempt(params, { bindingStore });
    const outcome = run.then(
      (result) => ({ terminal: readAttemptTerminal(result) }),
      (error: unknown) => ({ error }),
    );
    try {
      await run.waitForTurnAccepted();
      abort.abort("cancel resumed attempt");
      await harness.waitForMethod("turn/interrupt");
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-existing",
          turn: { id: "turn-1", status: "interrupted", items: [] },
        },
      });
      await expect(outcome).resolves.toMatchObject({
        terminal: { aborted: true, timedOut: false, promptError: null },
      });
      expect(harness.requests).toContainEqual({
        method: "thread/backgroundTerminals/list",
        params: { threadId: "thread-existing" },
      });
      expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(true);
      expect(harness.requests.some(({ method }) => method === "thread/start")).toBe(false);
    } finally {
      abort.abort("test cleanup");
      await outcome;
    }
  });
});
