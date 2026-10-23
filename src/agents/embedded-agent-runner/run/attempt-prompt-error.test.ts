import { beforeEach, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  handleMidTurnPrecheckRequest: vi.fn(),
  isMidTurnPrecheckSignal: vi.fn(() => false),
  isSessionsYieldAbortError: vi.fn(() => false),
  markYieldAborted: vi.fn(),
  sendCustomMessage: vi.fn(async () => undefined),
  releaseLeasedSteering: vi.fn(),
  stripSessionsYieldArtifacts: vi.fn(),
  waitForEmbeddedAbortSettle: vi.fn(async () => undefined),
  withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
}));

vi.mock("./attempt-sessions-yield.js", () => ({
  isSessionsYieldAbortError: hoisted.isSessionsYieldAbortError,
  stripSessionsYieldArtifacts: hoisted.stripSessionsYieldArtifacts,
}));
vi.mock("./attempt-subscription-cleanup.js", () => ({
  waitForEmbeddedAbortSettle: hoisted.waitForEmbeddedAbortSettle,
}));
vi.mock("./midturn-precheck.js", () => ({
  isMidTurnPrecheckSignal: hoisted.isMidTurnPrecheckSignal,
}));

import { SessionManager } from "../../sessions/session-manager.js";
import { handleEmbeddedAttemptPromptError as handleError } from "./attempt-prompt-submit.js";

type PromptErrorInput = Parameters<typeof handleError>[0];

function createInput(overrides: Partial<PromptErrorInput> = {}): PromptErrorInput {
  return {
    activeSession: {
      sendCustomMessage: hoisted.sendCustomMessage,
      sessionManager: SessionManager.inMemory(),
    },
    attempt: { runId: "run-1", sessionId: "session-1" },
    error: new Error("prompt failed"),
    handleMidTurnPrecheckRequest: hoisted.handleMidTurnPrecheckRequest,
    markYieldAborted: hoisted.markYieldAborted,
    releaseLeasedSteering: hoisted.releaseLeasedSteering,
    withOwnedTranscriptWrite: hoisted.withOwnedTranscriptWrite,
    yieldAbortSettled: null,
    yieldDetected: false,
    yieldMessage: null,
    ...overrides,
  } as PromptErrorInput;
}

beforeEach(() => vi.resetAllMocks());

it.each([false, true])("routes prompt failures (mid-turn precheck: %s)", async (precheck) => {
  const request = {
    route: "compact_only",
    estimatedPromptTokens: 12,
    promptBudgetBeforeReserve: 10,
    overflowTokens: 2,
    toolResultReducibleChars: 0,
    effectiveReserveTokens: 1,
  } as const;
  const error = precheck ? { request } : new Error("provider failed");
  hoisted.isMidTurnPrecheckSignal.mockReturnValue(precheck);
  await expect(handleError(createInput({ error }))).resolves.toEqual(
    precheck ? {} : { promptFailure: { error, source: "prompt" } },
  );
  expect(hoisted.releaseLeasedSteering).toHaveBeenCalledWith(error);
  if (precheck) {
    expect(hoisted.withOwnedTranscriptWrite).toHaveBeenCalledOnce();
    expect(hoisted.handleMidTurnPrecheckRequest).toHaveBeenCalledWith(request);
  }
});

it("persists yield handoff context without displaying it or triggering a turn", async () => {
  hoisted.isSessionsYieldAbortError.mockReturnValue(true);
  await expect(
    handleError(createInput({ yieldDetected: true, yieldMessage: "wait for follow-up" })),
  ).resolves.toEqual({});
  expect(hoisted.sendCustomMessage).toHaveBeenCalledWith(
    {
      customType: "openclaw.sessions_yield",
      content:
        "wait for follow-up\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]",
      display: false,
      details: { source: "sessions_yield", message: "wait for follow-up" },
    },
    { triggerTurn: false },
  );
});

it.each(["releaseLeasedSteering", "waitForEmbeddedAbortSettle"] as const)(
  "marks yield state before fallible %s",
  async (phase) => {
    const recoveryError = new Error("recovery failed");
    let marked = false;
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);
    hoisted[phase].mockImplementationOnce(async () => {
      expect(marked).toBe(true);
      throw recoveryError;
    });

    const input = createInput({
      markYieldAborted: () => {
        marked = true;
      },
      yieldDetected: true,
    });
    await expect(handleError(input)).rejects.toBe(recoveryError);
  },
);
