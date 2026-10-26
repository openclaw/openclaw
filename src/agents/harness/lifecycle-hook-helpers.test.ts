import { afterEach, describe, expect, it, vi } from "vitest";
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
} from "./lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages } from "./lifecycle-hook-messages.js";

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  messages: [],
  success: true,
};

const ctx = { runId: "run-1", sessionKey: "agent:main:session-1" };
type FinalizeParams = Parameters<typeof runAgentHarnessBeforeAgentFinalizeHook>[0];
function finalizer(results: unknown[], event: FinalizeParams["event"] = EVENT, context = ctx) {
  const hookRunner = {
    hasHooks: () => true,
    runBeforeAgentFinalize: async () => (results.length > 1 ? results.shift() : results[0]),
  } as never;
  return () => runAgentHarnessBeforeAgentFinalizeHook({ event, ctx: context, hookRunner });
}
async function expectRevisions(run: ReturnType<typeof finalizer>, reasons: (string | undefined)[]) {
  for (const reason of reasons) {
    await expect(run()).resolves.toEqual(
      reason === undefined ? { action: "continue" } : { action: "revise", reason },
    );
  }
}
function retry<Key>(instruction: string, idempotencyKey: Key) {
  return { instruction, idempotencyKey, maxAttempts: 1 };
}

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    log.warn.mockClear();
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.pluginFinalizeRetryBudget"));
  });

  it.each(["agent_end", "before_agent_finalize"] as const)(
    "loads %s evidence only for its subscriber and skips delivery when loading fails",
    async (hook) => {
      const messages = [{ role: "custom", content: "canonical evidence" }];
      const dispatch = vi.fn(async (_event: { messages?: unknown[] }) => undefined);
      const loadMessages = vi.fn(async () => messages);
      let enabled = false;
      const params = {
        ctx: { runId: EVENT.runId },
        event: EVENT,
        hookRunner: {
          hasHooks: () => enabled,
          runAgentEnd: dispatch,
          runBeforeAgentFinalize: dispatch,
        } as never,
      };
      const run = () => {
        bindAgentHarnessHookMessages(params.event, loadMessages);
        return hook === "agent_end"
          ? awaitAgentHarnessAgentEndHook(params)
          : runAgentHarnessBeforeAgentFinalizeHook(params);
      };
      await run();
      expect(loadMessages).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      enabled = true;
      loadMessages.mockRejectedValueOnce(new Error("transcript owner retired"));
      await run();
      expect(dispatch).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(`${hook} hook failed: Error: transcript owner retired`);
      await run();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ messages });
      expect(EVENT.messages).toEqual([]);
    },
  );

  it.each([false, true])("dispatches agent_end with unrefTimeout=%s", async (unrefTimeout) => {
    const { promise: agentEndSettled, resolve: releaseHook } = Promise.withResolvers<void>();
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };

    const params = { ctx, event: EVENT, hookRunner: hookRunner as never };
    const run = unrefTimeout
      ? runAgentHarnessAgentEndHook(params)
      : awaitAgentHarnessAgentEndHook(params);
    let resolved = false;
    if (run) {
      void run.then(() => {
        resolved = true;
      });
    }

    await Promise.resolve();
    expect(hookRunner.runAgentEnd).toHaveBeenCalledExactlyOnceWith(
      EVENT,
      expect.objectContaining(ctx),
      { unrefTimeout },
    );
    expect(resolved).toBe(false);
    releaseHook();
    if (!unrefTimeout) {
      await expect(run).resolves.toBeUndefined();
      expect(resolved).toBe(true);
    }
  });

  it("keys finalize retry budgets by context run id when the event omits run id", async () => {
    const run = finalizer(
      [{ action: "revise", retry: retry("revise from context run", "stable") }],
      { ...EVENT, runId: undefined, sessionId: "shared-session" },
      {
        runId: "run-from-context",
        sessionKey: "agent:main:shared-session",
      },
    );
    await expectRevisions(run, ["revise from context run", undefined]);
  });

  it("preserves merged reasons and advances to the next unspent finalize retry", async () => {
    const firstRetry = retry("regenerate artifacts", "artifacts");
    const secondRetry = retry("rerun focused tests", "tests");
    const result = {
      action: "revise",
      reason: "regenerate artifacts\n\nretry focused tests",
      retry: firstRetry,
      retryCandidates: [firstRetry, secondRetry],
    };
    const run = finalizer([result]);

    await expectRevisions(run, [result.reason, result.reason + "\n\nrerun focused tests"]);
  });

  it("deduplicates malformed retry keys by full instruction without prefix collisions", async () => {
    // Fallback keys include a digest of the full instruction. Prefix-only
    // truncation would spend unrelated long retry requests together.
    const sharedPrefix = "x".repeat(180);
    const firstInstruction = `${sharedPrefix} first`;
    const secondInstruction = `${sharedPrefix} second`;
    const run = finalizer([
      { action: "revise", retry: retry(firstInstruction, { invalid: true }) },
      { action: "revise", retry: retry(secondInstruction, { invalid: true }) },
      { action: "revise", retry: retry(firstInstruction, { invalid: true }) },
    ]);

    await expectRevisions(run, [firstInstruction, secondInstruction, undefined]);
  });
});
