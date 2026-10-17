import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
  getRequestInputText,
  getRequestInputTextAt,
  makeThreadBootstrapBinding,
  requestMethodsExcludingSkillDiscovery as requestMethods,
  requireRecord,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  readCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const contextEnginePolicyFingerprint =
  '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}';
const overflowMessage = "Codex ran out of room in the model's context window";
const configRequests = ["config/read", "configRequirements/read"];
const resumedRequests = [
  ...configRequests,
  "thread/read",
  "thread/resume",
  "thread/inject_items",
  "turn/start",
];
const freshRequests = [...configRequests, "thread/start", "turn/start"];

function bootstrapBinding(cwd: string) {
  return {
    ...makeThreadBootstrapBinding({
      threadId: "thread-old",
      cwd,
      policyFingerprint: contextEnginePolicyFingerprint,
      epoch: "epoch-before",
    }),
    webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
  };
}

function createOverflowFixture() {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const workspaceDir = path.join(tempDir, "workspace");
  openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
    assistantMessage("pre-compaction context", 10) as never,
  );
  const params = createParams(sessionFile, workspaceDir);
  params.contextTokenBudget = 400_000;
  const contextEngine = createProjectedContextEngine();
  params.contextEngine = contextEngine;
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  return { sessionFile, workspaceDir, params, identity, contextEngine };
}

function createProjectedContextEngine(includeEpoch = false) {
  return createContextEngine({
    assemble: vi.fn<ContextEngine["assemble"]>(async ({ messages, prompt }) => ({
      messages: [
        ...messages,
        ...(includeEpoch ? [assistantMessage("context epoch-before", 10)] : []),
        userMessage(prompt ?? "", 11),
      ],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
    })),
  });
}

function expectTurnRequests(harness: ReturnType<typeof resumedHarness>, starts: number) {
  expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(starts);
  expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
}

function expectFreshBinding(
  binding: ReturnType<ReturnType<typeof createCodexAppServerBindingStore>["read"]>,
  clientId: string,
) {
  expect(binding).toMatchObject({
    threadId: "thread-fresh",
    clientId,
    contextEngine: { engineId: "lossless-claw", policyFingerprint: contextEnginePolicyFingerprint },
  });
  expect(binding?.contextEngine?.projection).toBeUndefined();
}

function revocableHost(params: ReturnType<typeof createParams>, message: string) {
  const error = new Error(message);
  const original = params.hostCapabilities;
  let active = true;
  params.hostCapabilities = {
    ...original,
    assertActive() {
      original.assertActive();
      if (!active) {
        throw error;
      }
    },
  };
  return {
    error,
    revoke() {
      active = false;
    },
  };
}

function resumedHarness(onTurn: NonNullable<Parameters<typeof createStartedThreadHarness>[0]>) {
  return createStartedThreadHarness(
    async (method, params, options) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "turn/start") {
        return onTurn(method, params, options);
      }
      return undefined;
    },
    { persistedThreads: ["thread-old"] },
  );
}

function toolResultMessage(payload: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "bulk_context_probe",
    content: [{ type: "toolResult", toolUseId: `call-${timestamp}`, output: payload }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

setupRunAttemptTestHooks();

it.each([
  { nativeOwned: false, revokeAfterBirth: false },
  { nativeOwned: true, revokeAfterBirth: false },
  { nativeOwned: false, revokeAfterBirth: true },
])(
  "retries resumed context overflow only with host model ownership (expected native: $nativeOwned, revoked after birth: $revokeAfterBirth)",
  async ({ nativeOwned, revokeAfterBirth }) => {
    await withOpenClawTestState(
      { label: "codex-overflow-binding-birth", layout: "state-only", applyEnv: false },
      async (fixture) => {
        const { workspaceDir, params, identity } = createOverflowFixture();
        const stateStore = createCodexSqliteTestBindingStateStore({
          namespace: "overflow-context-bootstrap",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: fixture.env,
        });
        const bindingStore = createCodexAppServerBindingStore(stateStore);
        const nativeModel = threadStartResult("thread-old");
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: {
            ...bootstrapBinding(workspaceDir),
            ...(nativeOwned
              ? {
                  preserveNativeModel: true,
                  model: nativeModel.model,
                  modelProvider: nativeModel.modelProvider,
                }
              : {}),
          },
        });
        params.contextEngine = createProjectedContextEngine(true);
        params.contextEngine.compact = vi.fn<ContextEngine["compact"]>();
        const { assemble, compact } = params.contextEngine;
        const host = revocableHost(
          params,
          "overflow host authority revoked after fresh binding commit",
        );
        if (nativeOwned) {
          params.expectedSessionRuntimeOwnership = {
            model: "native",
            auth: "host",
            modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
          };
        }
        const bornBindings: NonNullable<ReturnType<typeof bindingStore.read>>[] = [];
        const mutationsAfterBirth: Parameters<typeof bindingStore.mutate>[1][] = [];
        const observedMutate: typeof bindingStore.mutate = async (...args) => {
          if (bornBindings.length > 0) {
            mutationsAfterBirth.push(structuredClone(args[1]));
          }
          const changed = await bindingStore.mutate(...args);
          const stored = bindingStore.read(identity);
          if (changed && bornBindings.length === 0 && stored?.threadId === "thread-fresh") {
            // Observe the real committed row before lifecycle publication or later repair.
            bornBindings.push(structuredClone(stored));
            if (revokeAfterBirth) {
              host.revoke();
            }
          }
          return changed;
        };
        const freshTurnStarted = createDeferred<void>();
        const harness = resumedHarness(async (method, requestParams) => {
          const request = requireRecord(requestParams, `${method} params`);
          if (request.threadId === "thread-old") {
            throw new Error(overflowMessage);
          }
          if (request.threadId === "thread-fresh") {
            freshTurnStarted.resolve();
            return turnStartResult("turn-fresh");
          }
          return undefined;
        });
        // Binding ownership is independent of real worker preparation time.
        vi.useFakeTimers({ toFake: ["Date"] });
        const run = runCodexAppServerAttempt(params, {
          bindingStore: { ...bindingStore, mutate: observedMutate },
        });
        try {
          if (nativeOwned) {
            await expect(run).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
            expect(harness.requests.some(({ method }) => method === "thread/start")).toBe(false);
            expect(bindingStore.read(identity)).toMatchObject({
              threadId: "thread-old",
              preserveNativeModel: true,
            });
            expect(bornBindings).toEqual([]);
            expect(compact).not.toHaveBeenCalled();
            return;
          }
          if (revokeAfterBirth) {
            await expect(run).rejects.toBe(host.error);
            expectTurnRequests(harness, 1);
            expect(getRequestInputTextAt(harness, -1)).toBe("hello");
          } else {
            await Promise.race([
              freshTurnStarted.promise,
              run.then((result) => {
                throw new Error("Codex attempt settled before fresh turn/start", {
                  cause: readAttemptTerminal(result),
                });
              }),
            ]);
            expect(requestMethods(harness)).toEqual([...resumedRequests, ...freshRequests]);
            await harness.notify({
              method: "turn/completed",
              params: {
                threadId: "thread-fresh",
                turnId: "turn-fresh",
                turn: {
                  id: "turn-fresh",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
                },
              },
            });
            const result = await run;
            expect(result.assistantTexts).toContain("fresh answer");
            expect(getRequestInputTextAt(harness, -1)).toBe("hello");
          }
          expect(compact).not.toHaveBeenCalled();
          expect(assemble).toHaveBeenCalledTimes(1);
          expect(bornBindings).toHaveLength(1);
          expectFreshBinding(bornBindings[0], harness.client.getInstanceId());
          expect(mutationsAfterBirth).toEqual(
            revokeAfterBirth
              ? []
              : [
                  {
                    kind: "patch",
                    threadId: "thread-fresh",
                    clientId: harness.client.getInstanceId(),
                    patch: { historyCoveredThrough: expect.any(String) },
                  },
                ],
          );
          expectFreshBinding(bindingStore.read(identity), harness.client.getInstanceId());
        } finally {
          await harness.client.closeAndWait();
          await run.catch(() => undefined);
        }
      },
    );
  },
);

it("preserves the binding when host authority expires while overflow recovery waits", async () => {
  const { workspaceDir, params, identity } = createOverflowFixture();
  const recoveryEntered = createDeferred<void>();
  const releaseRecovery = createDeferred<void>();
  const stateStore = createCodexTestBindingStateStore();
  const originalWithCurrent = stateStore.withCurrent.bind(stateStore);
  let overflowRejected = false;
  let recoveryPaused = false;
  stateStore.withCurrent = (options) => {
    const current = originalWithCurrent(options);
    return {
      ...current,
      async compareAndApply(key, comparison, intent) {
        if (
          overflowRejected &&
          !recoveryPaused &&
          intent.operation === "update" &&
          intent.action === "set" &&
          intent.value.state === "cleared"
        ) {
          recoveryPaused = true;
          recoveryEntered.resolve();
          await releaseRecovery.promise;
        }
        return current.compareAndApply(key, comparison, intent);
      },
    };
  };
  const bindingStore = createCodexAppServerBindingStore(stateStore);
  await bindingStore.mutate(identity, {
    kind: "set",
    binding: bootstrapBinding(workspaceDir),
  });
  const host = revocableHost(params, "overflow recovery host authority revoked");
  const harness = resumedHarness(async () => {
    overflowRejected = true;
    throw new Error(overflowMessage);
  });
  const run = runCodexAppServerAttempt(params, { bindingStore });
  try {
    await Promise.race([
      recoveryEntered.promise,
      run.then(() => {
        throw new Error("Codex attempt settled before overflow recovery admission");
      }),
    ]);
    const bindingBeforeRevocation = structuredClone(bindingStore.read(identity));
    expect(bindingBeforeRevocation).toMatchObject({ threadId: "thread-old" });
    host.revoke();
    releaseRecovery.resolve();

    await expect(run).rejects.toBe(host.error);
    expectTurnRequests(harness, 0);
    expect(bindingStore.read(identity)).toEqual(bindingBeforeRevocation);
  } finally {
    releaseRecovery.resolve();
    await harness.client.closeAndWait();
    await run.catch(() => undefined);
  }
});

it("preserves a newer context-engine binding when a stale resumed thread overflows", async () => {
  const { sessionFile, workspaceDir, params, contextEngine } = createOverflowFixture();
  await writeCodexAppServerBinding(sessionFile, bootstrapBinding(workspaceDir));
  contextEngine.compact = vi.fn<ContextEngine["compact"]>();
  const harness = resumedHarness(async (method, requestParams) => {
    const request = requireRecord(requestParams, `${method} params`);
    if (request.threadId === "thread-old") {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-new",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
      });
      throw new Error(overflowMessage);
    }
    return undefined;
  });

  await expect(runCodexAppServerAttempt(params)).rejects.toThrow(overflowMessage);

  expect(contextEngine.compact).not.toHaveBeenCalled();
  expect(requestMethods(harness)).toEqual([...resumedRequests, "thread/unsubscribe"]);
  const savedBinding = await readCodexAppServerBinding(sessionFile);
  expect(savedBinding?.threadId).toBe("thread-new");
});
it.each([false, true])("leaves first-turn compaction to Codex (overflow: %s)", async (overflow) => {
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  if (!overflow) {
    openFileBackedSessionManagerForTest(params.sessionFile, {
      sessionId: "session-1",
    }).appendMessage(assistantMessage("pre-compaction context", 10) as never);
  }
  const compact = overflow
    ? vi.fn<ContextEngine["compact"]>()
    : vi.fn<ContextEngine["compact"]>(async () => ({
        ok: true,
        compacted: true,
        result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
      }));
  const hugePayload = {
    rows: Array.from({ length: 10 }, (_, id) => ({
      id,
      body: "0123456789abcdef".repeat(4000),
    })),
  };
  const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
    messages: overflow
      ? [assistantMessage("large projected context", 10)]
      : Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
    estimatedTokens: 100_000,
    contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
  });
  const harness = createStartedThreadHarness(async (method) => {
    if (overflow && method === "turn/start") {
      throw new Error(overflowMessage);
    }
    return undefined;
  });
  params.contextEngine = createContextEngine({ assemble, compact });
  params.contextTokenBudget = 16_000;
  const run = runCodexAppServerAttempt(params);
  if (overflow) {
    await expect(run).rejects.toThrow(overflowMessage);
  } else {
    await harness.waitForMethod("turn/start");
    expect(getRequestInputText(harness)).toContain("0123456789abcdef");
    expect(requestMethods(harness)).toEqual(freshRequests);
    await harness.completeTurn();
    expect((await run).assistantTexts).toContain("final answer");
  }
  expect(compact).not.toHaveBeenCalled();
  expect(assemble).toHaveBeenCalledTimes(1);
  if (overflow) {
    expect(requestMethods(harness)).toEqual([...freshRequests, "thread/unsubscribe"]);
  }
});
