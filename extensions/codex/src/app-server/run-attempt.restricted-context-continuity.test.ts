import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { expect, it, onTestFinished, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { createModelFixture } from "./model-fixture.test-support.js";
import { requestParams as requireRequestParams } from "./run-attempt-continuity.test-support.js";
import {
  assistantMessage,
  createRuntimeDynamicTool,
  setCodexTestModelSupportsTools,
  bindProductionHarnessHostCapabilitiesForTest,
  runCodexAppServerAttempt as runUnmodifiedCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexAppServerClientFactoryForTest,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  requireRecord,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

function restrictedHarness(threadId = "thread-1", previousThread?: string, cwd?: string) {
  return createStartedThreadHarness(
    async (method) => {
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/start" || (cwd !== undefined && method === "thread/resume")) {
        return threadStartResult(threadId, cwd === undefined ? undefined : { cwd });
      }
      return undefined;
    },
    previousThread === undefined ? undefined : { persistedThreads: [previousThread] },
  );
}

setupRunAttemptTestHooks();

it.each(["changed", "failed", "rejected"])(
  "retains the admitted LCM assembly through settled-error client replacement (%s reassembly)",
  async (reassembly) => {
    const sessionFile = path.join(tempDir, "replacement-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "replacement-workspace");
    const manager = openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
    await manager.appendMessageAsync(assistantMessage("admitted replacement history", 10));
    const params = createParams(sessionFile, workspaceDir);
    const prepared = {
      messages: [assistantMessage("admitted replacement history", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "admitted replacement instructions",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: "admitted-epoch" },
    };
    const assemble = vi.fn(async () => prepared);
    if (reassembly === "rejected") {
      // A prior ordinary assembly failure leaves a compatible, unprojected binding.
      assemble.mockRejectedValue(new Error("initial assembly unavailable"));
    }
    params.contextEngine = createContextEngine({ assemble });
    params.pluginHarnessToolPolicyRestricted = true;
    params.pluginHarnessToolPolicyScope = "conversation";
    params.config = { tools: { deny: ["browser"], web: { search: { enabled: false } } } };
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("lookup_record")]);
    onTestFinished(await bindProductionHarnessHostCapabilitiesForTest(params));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const priming = createStartedThreadHarness(
      async (method) => {
        if (method === "model/list") {
          return { data: [createModelFixture(params.modelId)], nextCursor: null };
        }
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-1", { cwd: workspaceDir });
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const initial = runUnmodifiedCodexAppServerAttempt(params);
    await initial.waitForTurnAccepted();
    await priming.completeTurn();
    await initial;
    await priming.client.closeAndWait();
    assemble.mockClear();
    if (reassembly === "rejected") {
      assemble.mockRejectedValueOnce(new Error("admitted assembly unavailable"));
    } else {
      assemble.mockResolvedValueOnce(prepared);
    }
    assemble.mockImplementation(async () => {
      if (reassembly === "failed") {
        throw new Error("second assembly must not run");
      }
      return {
        ...prepared,
        messages: [assistantMessage("changed background history", 20)],
        systemPromptAddition: "changed background instructions",
        contextProjection: { mode: "thread_bootstrap", epoch: "background-epoch" },
      };
    });
    const clients = [true, false].map((listed) =>
      createCodexLifecycleHarness({
        persistedThreads: ["thread-1"],
        respond: async (method) => {
          if (method === "model/list") {
            return { data: listed ? [createModelFixture(params.modelId)] : [], nextCursor: null };
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "skills/list") {
            return { data: [] };
          }
          if (method === "mcpServerStatus/list") {
            return { data: [], nextCursor: null };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return threadStartResult(listed ? "thread-1" : "thread-replacement", {
              cwd: workspaceDir,
            });
          }
          return method === "turn/start" ? turnStartResult() : {};
        },
      }),
    );
    const [first, second] = clients;
    onTestFinished(async () => {
      await Promise.all(clients.map(({ client }) => client.closeAndWait()));
    });
    const failed = threadStartResult("thread-1", { cwd: workspaceDir });
    first!.seed(
      { ...failed, thread: { ...failed.thread, status: { type: "systemError" } } },
      { loaded: true, subscribed: false },
    );
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockClear()
      .mockResolvedValueOnce(first!.client)
      .mockResolvedValueOnce(second!.client);
    setCodexAppServerClientFactoryForTest(async (_start, _auth, _agent, _config, options) =>
      getLeasedSharedCodexAppServerClient({
        ...options,
        startOptions: {
          transport: "stdio",
          command: process.execPath,
          args: ["app-server"],
          headers: {},
        },
        agentDir: path.join(tempDir, "replacement-agent"),
        authProfileId: null,
        config: {},
      }),
    );
    const run = runUnmodifiedCodexAppServerAttempt(params);
    await Promise.race([
      first!.waitForMethod("thread/read"),
      run.then(() => {
        throw new Error("Attempt settled before reading the failed native thread");
      }),
    ]);
    const readIndex = first!.request.mock.calls.findIndex(([method]) => method === "thread/read");
    await first!.request.mock.results[readIndex]!.value;
    await vi.advanceTimersByTimeAsync(2_000);
    await run.waitForTurnAccepted();
    second!.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-replacement",
        turn: { id: "turn-1", status: "completed", items: [] },
      },
    });
    await run;
    const requests = clients.map(({ writes }) => writes.map((line) => JSON.parse(line)));
    expect(start).toHaveBeenCalledTimes(2);
    expect(
      requests.map((items) => items.filter((item) => item.method === "model/list").length),
    ).toEqual([1, 1]);
    expect(
      requests.map((items) => items.filter((item) => item.method === "turn/start").length),
    ).toEqual([0, 1]);
    const thread = requests[1]!.find((item) => item.method === "thread/start").params;
    const turn = requests[1]!.find((item) => item.method === "turn/start").params;
    expect(JSON.stringify(turn.input)).not.toContain("changed background history");
    expect(thread.developerInstructions).not.toContain("changed background instructions");
    expect(assemble).toHaveBeenCalledTimes(1);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({
      threadId: "thread-replacement",
      dynamicToolsContainDeferred: false,
    });
    if (reassembly === "rejected") {
      expect(JSON.stringify(turn.input)).toContain(params.prompt);
      expect(thread.developerInstructions).not.toContain("admitted replacement instructions");
      expect(binding?.contextEngine?.projection).toBeUndefined();
    } else {
      expect(JSON.stringify(turn.input)).toContain("admitted replacement history");
      expect(thread.developerInstructions).toContain("admitted replacement instructions");
      expect(binding).toMatchObject({
        contextEngine: { projection: { epoch: "admitted-epoch" } },
      });
    }
  },
);

it.each([false, true])(
  "migrates a browser-denied binding across LCM epochs and late policy rotation (search enabled: %s)",
  async (searchEnabled) => {
    const sessionFile = path.join(tempDir, "session-restricted-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-restricted-continuity");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    await sessionManager.appendMessageAsync(assistantMessage("retained LCM history", 10));
    await writeCodexAppServerBinding(
      sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-legacy",
        cwd: workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        epoch: "epoch-1",
      }),
    );
    let currentEpoch = "epoch-1";
    const attemptParams = createParams(sessionFile, workspaceDir);
    const assemble = vi.fn(async ({ prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: [assistantMessage("retained LCM history", 10), userMessage(prompt ?? "", 11)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: currentEpoch },
    }));
    attemptParams.contextEngine = createContextEngine({ assemble });
    attemptParams.config = {
      tools: { deny: ["browser"], web: { search: { enabled: searchEnabled } } },
    };
    attemptParams.pluginHarnessToolPolicyRestricted = true;
    attemptParams.pluginHarnessToolPolicyScope = "conversation";

    for (const [previousThread, threadId, epoch, startsFresh] of [
      ["thread-legacy", "thread-restricted", "epoch-1", true],
      ["thread-restricted", "thread-restricted", "epoch-1", false],
      ["thread-restricted", "thread-compacted", "epoch-2", true],
      ["thread-compacted", "thread-compacted", "epoch-2", false],
    ] as const) {
      currentEpoch = epoch;
      const harness = restrictedHarness(threadId, previousThread, workspaceDir);
      const attemptRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
      await attemptRun.waitForTurnAccepted();

      const nativeLifecycleRequests = harness.requests
        .filter(({ method }) => method === "thread/start" || method === "thread/resume")
        .map(({ method }) => method);
      expect(nativeLifecycleRequests).toEqual([startsFresh ? "thread/start" : "thread/resume"]);
      const inputText = getRequestInputText(harness);
      if (startsFresh) {
        expect(inputText).toContain("OpenClaw assembled context for this turn:");
        expect(inputText).toContain("retained LCM history");
        const startParams = requireRequestParams(harness, "thread/start");
        expect(requireRecord(startParams.config, "thread/start config")).toMatchObject({
          "features.code_mode": false,
          "features.code_mode_only": false,
        });
      } else {
        expect(inputText).toBe(attemptParams.prompt);
        expect(requireRequestParams(harness, "thread/resume").threadId).toBe(threadId);
      }
      await harness.completeTurn("completed", threadId);
      await attemptRun;

      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        threadId,
        nativeToolPolicyRestricted: true,
        restrictedThreadConfigFingerprint: expect.any(String),
        contextEngine: { projection: { mode: "thread_bootstrap", epoch } },
      });
      await harness.client.closeAndWait();
    }
    const prepared = {
      messages: [assistantMessage("prepared LCM snapshot", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: currentEpoch },
    };
    assemble.mockResolvedValueOnce(prepared);
    assemble.mockResolvedValue({
      messages: [assistantMessage("new background LCM snapshot", 20)],
      estimatedTokens: 42,
      systemPromptAddition: "changed background developer instructions",
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-3" },
    });
    attemptParams.extraSystemPrompt = "Updated conversation tool policy.";
    const successorHarness = restrictedHarness("thread-policy-successor", "thread-compacted");
    const successorRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
    await successorRun.waitForTurnAccepted();
    expect(assemble).toHaveBeenCalledTimes(5);
    expect(successorHarness.requests.map(({ method }) => method)).toContain("thread/start");
    expect(getRequestInputText(successorHarness)).toContain("prepared LCM snapshot");
    expect(getRequestInputText(successorHarness)).not.toContain("new background LCM snapshot");
    const startParams = requireRequestParams(successorHarness, "thread/start");
    expect(startParams.developerInstructions).toContain("context-engine system");
    expect(startParams.developerInstructions).not.toContain(
      "changed background developer instructions",
    );
    await successorHarness.completeTurn("completed", "thread-policy-successor");
    await successorRun;
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-policy-successor",
      contextEngine: { projection: { mode: "thread_bootstrap", epoch: "epoch-2" } },
    });
  },
);

it("retains LCM history when a later catalog failure rotates deferred loading to direct", async () => {
  const sessionFile = path.join(tempDir, "catalog-transition.jsonl");
  const workspaceDir = path.join(tempDir, "catalog-transition-workspace");
  const manager = openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
  await manager.appendMessageAsync(assistantMessage("retained catalog-transition history", 10));
  const params = createParams(sessionFile, workspaceDir);
  params.contextEngine = createContextEngine({
    assemble: vi.fn(async ({ prompt }) => ({
      messages: [
        assistantMessage("retained catalog-transition history", 10),
        userMessage(prompt ?? "", 11),
      ],
      estimatedTokens: 42,
      contextProjection: { mode: "thread_bootstrap" as const, epoch: "catalog-epoch" },
    })),
  });
  params.pluginHarnessToolPolicyRestricted = true;
  params.pluginHarnessToolPolicyScope = "conversation";
  params.config = { tools: { deny: ["browser"], web: { search: { enabled: false } } } };
  setCodexTestModelSupportsTools(params, true);
  setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("lookup_record")]);
  onTestFinished(await bindProductionHarnessHostCapabilitiesForTest(params));
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  for (const [listed, previousThread, threadId] of [
    [true, undefined, "thread-listed"],
    [false, "thread-listed", "thread-direct"],
  ] as const) {
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "model/list") {
          if (!listed) {
            throw new Error("catalog temporarily unavailable");
          }
          return { data: [createModelFixture(params.modelId)], nextCursor: null };
        }
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "thread/start") {
          return threadStartResult(threadId);
        }
        return undefined;
      },
      previousThread ? { persistedThreads: [previousThread] } : {},
    );
    const run = runUnmodifiedCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    expect(getRequestInputText(harness)).toContain("retained catalog-transition history");
    expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    await harness.completeTurn("completed", threadId);
    await run;
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId,
      dynamicToolsContainDeferred: listed,
      contextEngine: { projection: { epoch: "catalog-epoch" } },
    });
    await harness.client.closeAndWait();
  }
});
