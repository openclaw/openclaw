import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
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

function toolResultMessage(payload: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "bulk_context_probe",
    content: [
      {
        type: "toolResult",
        toolUseId: `call-${timestamp}`,
        output: payload,
      },
    ],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt context-engine overflow recovery", () => {
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
          const sessionFile = path.join(tempDir, "session.jsonl");
          const workspaceDir = path.join(tempDir, "workspace");
          openFileBackedSessionManagerForTest(sessionFile, {
            sessionId: "session-1",
          }).appendMessage(assistantMessage("pre-compaction context", 10) as never);
          const params = createParams(sessionFile, workspaceDir);
          const identity = {
            kind: "session" as const,
            agentId: "main",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          };
          const stateStore = createCodexSqliteTestBindingStateStore({
            namespace: "overflow-context-bootstrap",
            maxEntries: 10,
            overflowPolicy: "reject-new",
            env: fixture.env,
          });
          const bindingStore = createCodexAppServerBindingStore(stateStore);
          const nativeModel = threadStartResult("thread-old");
          const contextEnginePolicyFingerprint =
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}';
          await bindingStore.mutate(identity, {
            kind: "set",
            binding: {
              threadId: "thread-old",
              cwd: workspaceDir,
              dynamicToolsFingerprint: "[]",
              webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
              ...(nativeOwned
                ? {
                    preserveNativeModel: true,
                    model: nativeModel.model,
                    modelProvider: nativeModel.modelProvider,
                  }
                : {}),
              contextEngine: {
                schemaVersion: 1,
                engineId: "lossless-claw",
                policyFingerprint: contextEnginePolicyFingerprint,
                projection: {
                  schemaVersion: 1,
                  mode: "thread_bootstrap",
                  epoch: "epoch-before",
                },
              },
            },
          });
          const compact = vi.fn(async () => ({
            ok: true,
            compacted: true,
            result: {
              summary: "summary",
              firstKeptEntryId: "entry-1",
              tokensBefore: 10,
              sessionId: "session-1-compacted",
            },
          }));
          const assemble = vi.fn(
            async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
              messages: [
                ...messages,
                assistantMessage("context epoch-before", 10),
                userMessage(prompt ?? "", 11),
              ],
              estimatedTokens: 42,
              systemPromptAddition: "context-engine system",
              contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
            }),
          );
          params.contextEngine = createContextEngine({ assemble, compact });
          params.contextTokenBudget = 400_000;
          const revoked = new Error("overflow host authority revoked after fresh binding commit");
          const originalAssertActive = params.hostCapabilities.assertActive;
          let hostActive = true;
          params.hostCapabilities = {
            ...params.hostCapabilities,
            assertActive() {
              originalAssertActive();
              if (!hostActive) {
                throw revoked;
              }
            },
          };
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
                hostActive = false;
              }
            }
            return changed;
          };
          const freshTurnStarted = createDeferred<void>();
          const harness = createStartedThreadHarness(
            async (method, requestParams) => {
              if (method === "thread/resume") {
                return threadStartResult("thread-old");
              }
              if (method === "thread/start") {
                return threadStartResult("thread-fresh");
              }
              if (method === "turn/start") {
                const request = requireRecord(requestParams, `${method} params`);
                if (request.threadId === "thread-old") {
                  throw new Error("Codex ran out of room in the model's context window");
                }
                if (request.threadId === "thread-fresh") {
                  freshTurnStarted.resolve();
                  return turnStartResult("turn-fresh");
                }
              }
              return undefined;
            },
            { persistedThreads: ["thread-old"] },
          );
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
              await expect(run).rejects.toBe(revoked);
              expect(
                harness.requests.filter(({ method }) => method === "thread/start"),
              ).toHaveLength(1);
              expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(
                1,
              );
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
              expect(harness.requests.map((request) => request.method)).toEqual([
                "config/read",
                "configRequirements/read",
                "thread/read",
                "thread/resume",
                "thread/inject_items",
                "turn/start",
                "config/read",
                "configRequirements/read",
                "thread/start",
                "turn/start",
              ]);
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
            expect(bornBindings[0]).toMatchObject({
              threadId: "thread-fresh",
              contextEngine: {
                engineId: "lossless-claw",
                policyFingerprint: contextEnginePolicyFingerprint,
              },
            });
            expect(bornBindings[0]?.contextEngine?.projection).toBeUndefined();
            expect(mutationsAfterBirth).toEqual(
              revokeAfterBirth
                ? []
                : [
                    {
                      kind: "patch",
                      threadId: "thread-fresh",
                      patch: { historyCoveredThrough: expect.any(String) },
                    },
                  ],
            );
            const savedBinding = bindingStore.read(identity);
            expect(savedBinding?.threadId).toBe("thread-fresh");
            expect(savedBinding?.contextEngine?.engineId).toBe("lossless-claw");
            expect(savedBinding?.contextEngine?.projection).toBeUndefined();
          } finally {
            await harness.client.closeAndWait();
            await run.catch(() => undefined);
          }
        },
      );
    },
  );

  it("preserves the binding when host authority expires while overflow recovery waits", async () => {
    const sessionFile = path.join(tempDir, "overflow-revoked.jsonl");
    const workspaceDir = path.join(tempDir, "overflow-revoked-workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", 10) as never,
    );
    const params = createParams(sessionFile, workspaceDir);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
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
      binding: {
        ...makeThreadBootstrapBinding({
          threadId: "thread-old",
          cwd: workspaceDir,
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
          epoch: "epoch-before",
        }),
        webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      },
    });
    params.contextEngine = createContextEngine({
      assemble: async ({ messages, prompt }) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      }),
    });
    params.contextTokenBudget = 400_000;
    const revoked = new Error("overflow recovery host authority revoked");
    const originalAssertActive = params.hostCapabilities.assertActive;
    let hostActive = true;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertActive() {
        originalAssertActive();
        if (!hostActive) {
          throw revoked;
        }
      },
    };
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-old");
        }
        if (method === "turn/start") {
          overflowRejected = true;
          throw new Error("Codex ran out of room in the model's context window");
        }
        return undefined;
      },
      { persistedThreads: ["thread-old"] },
    );
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
      hostActive = false;
      releaseRecovery.resolve();

      await expect(run).rejects.toBe(revoked);
      expect(harness.requests.filter(({ method }) => method === "thread/start")).toEqual([]);
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
      expect(bindingStore.read(identity)).toEqual(bindingBeforeRevocation);
    } finally {
      releaseRecovery.resolve();
      await harness.client.closeAndWait();
      await run.catch(() => undefined);
    }
  });

  it("returns a replay-safe recovery result when the executable owner changes during overflow retry", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(
      sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-old",
        cwd: workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        epoch: "epoch-before",
      }),
    );
    const contextEngine = createContextEngine({
      assemble: async ({ messages, prompt }) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      }),
    });
    const successorStart = vi.fn(() => threadStartResult("thread-fresh"));
    const harness = createStartedThreadHarness(
      async (method, requestParams) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-old");
        }
        if (method === "turn/start") {
          const request = requireRecord(requestParams, `${method} params`);
          if (request.threadId === "thread-old") {
            // Selection changes after the original turn writes; the successor is rejected locally.
            harness.client.setThreadSessionRequestGuard(async () => {
              throw Object.assign(
                new Error("managed executable selection changed during startup"),
                {
                  code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
                },
              );
            });
            throw new Error("Codex ran out of room in the model's context window");
          }
        }
        if (method === "thread/start") {
          return successorStart();
        }
        return undefined;
      },
      { persistedThreads: ["thread-old"] },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const result = await runCodexAppServerAttempt(params);

    expect(readAttemptTerminal(result).promptError).toContain("codex app-server client is closed");
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-old",
      replaySafe: true,
    });
    expect(harness.requests.map((request) => request.method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "thread/unsubscribe",
    ]);
    expect(successorStart).not.toHaveBeenCalled();
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
  });

  it("preserves a newer context-engine binding when a stale resumed thread overflows", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(
      sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-old",
        cwd: workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        epoch: "epoch-before",
      }),
    );
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(
      async (method, requestParams) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-old");
        }
        if (method === "turn/start") {
          const request = requireRecord(requestParams, `${method} params`);
          if (request.threadId === "thread-old") {
            await writeCodexAppServerBinding(sessionFile, {
              threadId: "thread-new",
              cwd: workspaceDir,
              dynamicToolsFingerprint: "[]",
            });
            throw new Error("Codex ran out of room in the model's context window");
          }
        }
        if (method === "thread/start") {
          return threadStartResult("thread-fresh");
        }
        return undefined;
      },
      { persistedThreads: ["thread-old"] },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex ran out of room in the model's context window",
    );

    expect(compact).not.toHaveBeenCalled();
    expect(harness.requests.map((request) => request.method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
  });
  it("does not pre-compact over-budget rendered context-engine prompts before Codex turn/start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("0123456789abcdef");

    await harness.completeTurn();
    const result = await run;
    expect(result.assistantTexts).toContain("final answer");
  });

  it("fails first-turn Codex context overflow instead of falling back to OpenClaw compaction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: [assistantMessage("large projected context", 10)],
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex ran out of room in the model's context window",
    );

    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  it("does not call hung owning context-engine compaction during Codex overflow recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(
      sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-old",
        cwd: workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        epoch: "epoch-before",
      }),
    );
    const compact = vi.fn<ContextEngine["compact"]>(() => new Promise(() => {}));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(
      async (method, requestParams) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-old");
        }
        if (method === "thread/start") {
          return threadStartResult("thread-fresh");
        }
        if (method === "turn/start") {
          const request = requireRecord(requestParams, `${method} params`);
          if (request.threadId === "thread-old") {
            throw new Error("Codex ran out of room in the model's context window");
          }
          if (request.threadId === "thread-fresh") {
            return turnStartResult("turn-fresh");
          }
        }
        return undefined;
      },
      { persistedThreads: ["thread-old"] },
    );
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.requests.map((request) => request.method)).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/read",
          "thread/resume",
          "thread/inject_items",
          "turn/start",
          "config/read",
          "configRequirements/read",
          "thread/start",
          "turn/start",
        ]),
      { timeout: 4_000 },
    );
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
    expect(compact).not.toHaveBeenCalled();
  });
});
