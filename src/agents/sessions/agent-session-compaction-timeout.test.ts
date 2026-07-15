// Covers timeout-partial compaction ownership, persistence, and write-lock ordering.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import {
  CompactionSafetyTimeoutError,
  isCompactionTimeoutPartialResult,
  markCompactionTimeoutPartialResult,
} from "../compaction-timeout.js";
import { compactWithSafetyTimeout } from "../embedded-agent-runner/compaction-safety-timeout.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createResourceLoaderWithHandlers(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function appendPersistedAssistantMessage(params: {
  sessionManager: SessionManager;
  content: unknown;
  stopReason?: "stop" | "aborted";
}) {
  return params.sessionManager.appendMessage({
    role: "assistant",
    content: params.content,
    api: "messages",
    provider: "anthropic",
    model: "sonnet-4.6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: params.stopReason ?? "stop",
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);
}

describe("AgentSession compaction timeout partial results", () => {
  it("commits an explicitly marked partial result after the safety timeout abort", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "user context ".repeat(200),
      timestamp: 1,
    } as Parameters<SessionManager["appendMessage"]>[0]);
    const unsummarizedAssistantEntryId = appendPersistedAssistantMessage({
      sessionManager,
      content: "assistant context ".repeat(200),
    });

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    const timeoutError = new CompactionSafetyTimeoutError();
    const resourceLoader = createResourceLoaderWithHandlers(
      new Map([
        [
          "session_before_compact",
          [
            async (rawEvent: unknown) => {
              const event = rawEvent as {
                preparation: {
                  firstKeptEntryId: string;
                  messagesToSummarize: unknown[];
                  messageEntryIdsToSummarize?: string[];
                  tokensBefore: number;
                };
                signal: AbortSignal;
              };
              expect(event.preparation.messageEntryIdsToSummarize).toHaveLength(
                event.preparation.messagesToSummarize.length,
              );
              session.abortCompaction(timeoutError);
              expect(event.signal.reason).toBe(timeoutError);
              return {
                compaction: markCompactionTimeoutPartialResult({
                  summary: "partial summary committed after timeout",
                  firstKeptEntryId: unsummarizedAssistantEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                }),
              };
            },
          ],
        ],
      ]),
    );

    const { session } = await createAgentSession({
      model: testModel,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
      }),
    });

    await expect(session.compact()).resolves.toMatchObject({
      summary: "partial summary committed after timeout",
    });
    expect(sessionManager.getEntries()).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        summary: "partial summary committed after timeout",
      }),
    );
    expect(sessionManager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "assistant context ".repeat(200),
      }),
    );
  });

  it("resolves after committing a timeout partial result without waiting for post-commit hooks", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "user context ".repeat(200),
      timestamp: 1,
    } as Parameters<SessionManager["appendMessage"]>[0]);
    appendPersistedAssistantMessage({
      sessionManager,
      content: "assistant context ".repeat(200),
    });

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    let beforeCompactCalls = 0;
    let postCommitHookStarted = false;
    let releasePostCommitHook = () => {};
    const postCommitHookBlocked = new Promise<void>((resolve) => {
      releasePostCommitHook = resolve;
    });
    const resourceLoader = createResourceLoaderWithHandlers(
      new Map([
        [
          "session_before_compact",
          [
            async (rawEvent: unknown) => {
              beforeCompactCalls += 1;
              const event = rawEvent as {
                preparation: {
                  firstKeptEntryId: string;
                  tokensBefore: number;
                };
                signal: AbortSignal;
              };
              if (beforeCompactCalls === 1) {
                await new Promise<void>((resolve) => {
                  event.signal.addEventListener("abort", () => resolve(), { once: true });
                });
              }
              return {
                compaction: (beforeCompactCalls === 1
                  ? markCompactionTimeoutPartialResult
                  : <T extends object>(value: T) => value)({
                  summary:
                    beforeCompactCalls === 1
                      ? "partial summary committed before post-commit hook"
                      : "second compaction after ordered hook",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                }),
              };
            },
          ],
        ],
        [
          "session_compact",
          [
            async () => {
              postCommitHookStarted = true;
              if (beforeCompactCalls === 1) {
                await postCommitHookBlocked;
              }
            },
          ],
        ],
      ]),
    );

    let writeTail = Promise.resolve();
    const { session } = await createAgentSession({
      model: testModel,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
      }),
      withSessionWriteLock: async (run) => {
        const previous = writeTail;
        let release = () => {};
        writeTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await run();
        } finally {
          release();
        }
      },
    });

    try {
      await expect(
        compactWithSafetyTimeout(() => session.compact(), 25, {
          onCancel: (reason) => session.abortCompaction(reason),
          acceptResultAfterTimeout: isCompactionTimeoutPartialResult,
          timeoutResultGraceMs: 50,
        }),
      ).resolves.toMatchObject({
        summary: "partial summary committed before post-commit hook",
      });
      expect(postCommitHookStarted).toBe(true);
      expect(sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "compaction",
          summary: "partial summary committed before post-commit hook",
        }),
      );
      sessionManager.appendMessage({
        role: "user",
        content: "new work queued after the partial compaction commit",
        timestamp: Date.now(),
      } as Parameters<SessionManager["appendMessage"]>[0]);
      const secondCompaction = session.compact();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(beforeCompactCalls).toBe(1);
      releasePostCommitHook();
      await expect(secondCompaction).resolves.toMatchObject({
        summary: "second compaction after ordered hook",
      });
    } finally {
      releasePostCommitHook();
    }
  });

  it("cancels only the queued compaction whose safety timeout fired", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "user context ".repeat(200),
      timestamp: 1,
    } as Parameters<SessionManager["appendMessage"]>[0]);
    appendPersistedAssistantMessage({
      sessionManager,
      content: "assistant context ".repeat(200),
    });

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    let beforeCompactCalls = 0;
    let firstSignal: AbortSignal | undefined;
    let firstStarted = () => {};
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const resourceLoader = createResourceLoaderWithHandlers(
      new Map([
        [
          "session_before_compact",
          [
            async (rawEvent: unknown) => {
              beforeCompactCalls += 1;
              const event = rawEvent as {
                preparation: { firstKeptEntryId: string; tokensBefore: number };
                signal: AbortSignal;
              };
              if (beforeCompactCalls === 1) {
                firstSignal = event.signal;
                firstStarted();
                await firstBlocked;
                return { cancel: true };
              }
              return {
                compaction: {
                  summary: `compaction ${beforeCompactCalls}`,
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              };
            },
          ],
        ],
      ]),
    );
    let writeTail = Promise.resolve();
    const { session } = await createAgentSession({
      model: testModel,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
      }),
      withSessionWriteLock: async (run) => {
        const previous = writeTail;
        let release = () => {};
        writeTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await run();
        } finally {
          release();
        }
      },
    });

    const firstCompaction = session.compact();
    await firstStartedPromise;
    const queuedCompaction = compactWithSafetyTimeout(
      (signal) => session.compact(undefined, signal),
      25,
      { timeoutResultGraceMs: 10 },
    );

    await expect(queuedCompaction).rejects.toThrow("Compaction timed out");
    expect(firstSignal?.aborted).toBe(false);
    releaseFirst();
    await expect(firstCompaction).rejects.toThrow("Compaction cancelled");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(beforeCompactCalls).toBe(1);
    expect(sessionManager.getEntries()).not.toContainEqual(
      expect.objectContaining({ type: "compaction", summary: "compaction 2" }),
    );
  });

  it("does not start compaction after timing out while waiting for the session write lock", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "user context ".repeat(200),
      timestamp: 1,
    } as Parameters<SessionManager["appendMessage"]>[0]);
    appendPersistedAssistantMessage({
      sessionManager,
      content: "assistant context ".repeat(200),
    });

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
    let beforeCompactCalled = false;
    const resourceLoader = createResourceLoaderWithHandlers(
      new Map([
        [
          "session_before_compact",
          [
            async (rawEvent: unknown) => {
              beforeCompactCalled = true;
              const event = rawEvent as {
                preparation: { firstKeptEntryId: string; tokensBefore: number };
              };
              return {
                compaction: {
                  summary: "must not persist after lock-wait timeout",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              };
            },
          ],
        ],
      ]),
    );
    let notifyLockWaiting = () => {};
    const lockWaiting = new Promise<void>((resolve) => {
      notifyLockWaiting = resolve;
    });
    let releaseLock = () => {};
    const lockBlocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const { session } = await createAgentSession({
      model: testModel,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
      }),
      withSessionWriteLock: async (run) => {
        notifyLockWaiting();
        await lockBlocked;
        return await run();
      },
    });

    let pendingCompaction: Promise<unknown> | undefined;
    const wrappedCompaction = compactWithSafetyTimeout(
      () => {
        pendingCompaction = session.compact();
        return pendingCompaction;
      },
      25,
      {
        onCancel: (reason) => session.abortCompaction(reason),
        acceptResultAfterTimeout: isCompactionTimeoutPartialResult,
        timeoutResultGraceMs: 10,
      },
    );

    try {
      await lockWaiting;
      expect(session.isCompacting).toBe(true);
      await expect(wrappedCompaction).rejects.toThrow("Compaction timed out");
    } finally {
      releaseLock();
    }

    if (!pendingCompaction) {
      throw new Error("expected compaction to be queued behind the write lock");
    }
    await expect(pendingCompaction).rejects.toThrow();
    expect(session.isCompacting).toBe(false);
    expect(beforeCompactCalled).toBe(false);
    expect(sessionManager.getEntries()).not.toContainEqual(
      expect.objectContaining({
        type: "compaction",
        summary: "must not persist after lock-wait timeout",
      }),
    );
  });
});
