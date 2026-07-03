// Codex tests cover run attempt cleanup-window plugin behavior.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  mockClientRuntimeMethods,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
} from "./run-attempt-test-harness.js";

const activeRunRegistrationMocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    clearActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.clearActiveEmbeddedRun>
    ): ReturnType<typeof actual.clearActiveEmbeddedRun> => {
      activeRunRegistrationMocks.clearActiveEmbeddedRun(...args);
      return actual.clearActiveEmbeddedRun(...args);
    },
    setActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.setActiveEmbeddedRun>
    ): ReturnType<typeof actual.setActiveEmbeddedRun> => {
      activeRunRegistrationMocks.setActiveEmbeddedRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

vi.mock("./transcript-mirror.js", () => ({
  createCodexAppServerUserMessagePersistenceNotifier: vi.fn(() => {
    throw new Error("boom after turn acceptance");
  }),
  mirrorPromptAtTurnStartBestEffort: vi.fn(),
}));

setupRunAttemptTestHooks();

describe("Codex app-server cleanup window", () => {
  it("cleans up the active run if notifier construction throws after registration", async () => {
    let notificationCleanupCalled = 0;
    let requestCleanupCalled = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });

    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          addNotificationHandler: () => () => {
            notificationCleanupCalled += 1;
          },
          addRequestHandler: () => () => {
            requestCleanupCalled += 1;
          },
        }) as never,
    );

    const params = createParams(
      path.join(tempDir, "cleanup-window-session.jsonl"),
      path.join(tempDir, "cleanup-window-workspace"),
    );
    params.sessionId = "cleanup-window-session";
    params.sessionKey = "agent:main:cleanup-window-session";
    params.runId = "run-cleanup-window-session";

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("boom after turn acceptance");

    expect(activeRunRegistrationMocks.setActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
    expect(notificationCleanupCalled).toBe(1);
    expect(requestCleanupCalled).toBe(1);
  }, 20_000);
});
