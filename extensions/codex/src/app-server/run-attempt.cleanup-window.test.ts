// Codex tests cover run attempt cleanup-window plugin behavior.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const cleanupWindowMocks = vi.hoisted(() => ({
  activeRunRegistration: {
    clearActiveEmbeddedRun: vi.fn(),
    setActiveEmbeddedRun: vi.fn(),
  },
  throwOnSteeringQueueCreation: false,
  throwOnNotifierConstruction: false,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    clearActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.clearActiveEmbeddedRun>
    ): ReturnType<typeof actual.clearActiveEmbeddedRun> => {
      cleanupWindowMocks.activeRunRegistration.clearActiveEmbeddedRun(...args);
      return actual.clearActiveEmbeddedRun(...args);
    },
    setActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.setActiveEmbeddedRun>
    ): ReturnType<typeof actual.setActiveEmbeddedRun> => {
      cleanupWindowMocks.activeRunRegistration.setActiveEmbeddedRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

vi.mock("./transcript-mirror.js", () => ({
  createCodexAppServerUserMessagePersistenceNotifier: vi.fn(() => {
    if (cleanupWindowMocks.throwOnNotifierConstruction) {
      throw new Error("boom after turn acceptance");
    }
    return vi.fn();
  }),
  mirrorPromptAtTurnStartBestEffort: vi.fn(),
}));

vi.mock("./attempt-steering.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attempt-steering.js")>();
  return {
    ...actual,
    createCodexSteeringQueue: vi.fn(
      (...args: Parameters<typeof actual.createCodexSteeringQueue>) => {
        if (cleanupWindowMocks.throwOnSteeringQueueCreation) {
          throw new Error("boom before active run registration");
        }
        return actual.createCodexSteeringQueue(...args);
      },
    ),
  };
});

setupRunAttemptTestHooks();

afterEach(() => {
  cleanupWindowMocks.throwOnSteeringQueueCreation = false;
  cleanupWindowMocks.throwOnNotifierConstruction = false;
  cleanupWindowMocks.activeRunRegistration.clearActiveEmbeddedRun.mockClear();
  cleanupWindowMocks.activeRunRegistration.setActiveEmbeddedRun.mockClear();
});

describe("Codex app-server cleanup window", () => {
  it("cleans up the active run if notifier construction throws after registration", async () => {
    cleanupWindowMocks.throwOnNotifierConstruction = true;
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

    expect(cleanupWindowMocks.activeRunRegistration.setActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
    expect(cleanupWindowMocks.activeRunRegistration.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
    expect(notificationCleanupCalled).toBe(1);
    expect(requestCleanupCalled).toBe(1);
  }, 20_000);

  it("cleans up shared handlers if steering queue setup throws before active run registration", async () => {
    cleanupWindowMocks.throwOnSteeringQueueCreation = true;
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
      path.join(tempDir, "cleanup-window-phase-session.jsonl"),
      path.join(tempDir, "cleanup-window-phase-workspace"),
    );
    params.sessionId = "cleanup-window-phase-session";
    params.sessionKey = "agent:main:cleanup-window-phase-session";
    params.runId = "run-cleanup-window-phase-session";

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("boom before active run");

    expect(cleanupWindowMocks.activeRunRegistration.setActiveEmbeddedRun).not.toHaveBeenCalled();
    expect(cleanupWindowMocks.activeRunRegistration.clearActiveEmbeddedRun).not.toHaveBeenCalled();
    expect(notificationCleanupCalled).toBe(1);
    expect(requestCleanupCalled).toBe(1);
  }, 20_000);
});
