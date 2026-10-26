import { expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  waitForEmbeddedAbortSettle: vi.fn(async () => undefined),
}));

vi.mock("./attempt-subscription-cleanup.js", () => ({
  waitForEmbeddedAbortSettle: hoisted.waitForEmbeddedAbortSettle,
}));

import { SessionManager } from "../../sessions/session-manager.js";
import { handleEmbeddedAttemptPromptError as handleError } from "./attempt-prompt-submit.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

type PromptErrorInput = Parameters<typeof handleError>[0];

function createInput(overrides: Partial<PromptErrorInput> = {}): PromptErrorInput {
  return {
    activeSession: {
      messages: [],
      agent: { state: { messages: [] } },
      sendCustomMessage: vi.fn(),
      sessionManager: SessionManager.inMemory(),
    },
    attempt: { runId: "run-1", sessionId: "session-1" },
    error: new Error("prompt failed"),
    handleMidTurnPrecheckRequest: vi.fn(),
    markYieldAborted: vi.fn(),
    withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
    yieldAbortSettled: null,
    yieldDetected: false,
    yieldMessage: null,
    ...overrides,
  } as PromptErrorInput;
}

it.each([false, true])("routes prompt failures (mid-turn precheck: %s)", async (precheck) => {
  const request = {
    route: "compact_only",
    estimatedPromptTokens: 12,
    promptBudgetBeforeReserve: 10,
    overflowTokens: 2,
    toolResultReducibleChars: 0,
    effectiveReserveTokens: 1,
  } as const;
  const error = precheck ? new MidTurnPrecheckSignal(request) : new Error("provider failed");
  const input = createInput({ error });
  await expect(handleError(input)).resolves.toEqual(
    precheck ? {} : { promptFailure: { error, source: "prompt" } },
  );
  if (precheck) {
    expect(input.withOwnedTranscriptWrite).toHaveBeenCalledOnce();
    expect(input.handleMidTurnPrecheckRequest).toHaveBeenCalledWith(request);
  }
});

it.each([false, true])("settles yield handoff (recovery failure: %s)", async (fails) => {
  const recoveryError = new Error("recovery failed");
  const input = createInput({
    error: new Error("aborted", { cause: { code: "sessions_yield" } }),
    yieldDetected: true,
    yieldMessage: "wait for follow-up",
  });
  hoisted.waitForEmbeddedAbortSettle.mockImplementationOnce(async () => {
    expect(input.markYieldAborted).toHaveBeenCalledOnce();
    if (fails) {
      throw recoveryError;
    }
  });
  if (fails) {
    await expect(handleError(input)).rejects.toBe(recoveryError);
    return;
  }
  await expect(handleError(input)).resolves.toEqual({});
  expect(input.activeSession.sendCustomMessage).toHaveBeenCalledWith(
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
