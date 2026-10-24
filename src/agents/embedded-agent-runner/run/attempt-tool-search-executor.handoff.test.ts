import { expect, it } from "vitest";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { gatewayStub, validArgs } from "../../tools/ask-user-tool.gateway.test-fixture.js";
import { createAskUserTool } from "../../tools/ask-user-tool.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

async function withExecutor(
  tool: AnyAgentTool,
  runAbort: AbortController,
  consume: (fixture: {
    execute: (args: unknown, signal?: AbortSignal) => ReturnType<AnyAgentTool["execute"]>;
    subscription: ReturnType<typeof createSubscribedSessionHarness>["subscription"];
    manager: SessionManager;
  }) => Promise<void>,
) {
  const manager = SessionManager.inMemory();
  const { subscription } = createSubscribedSessionHarness({ runId: "nested-handoff" });
  const pending: Promise<unknown>[] = [];
  const runToolLifecycle: typeof subscription.runToolLifecycle = (params) => {
    const work = subscription.runToolLifecycle(params);
    pending.push(work);
    return work;
  };
  const executor = createSubscribedToolSearchExecutor({
    attempt: { runId: "nested-handoff", sessionKey: "agent:main:nested-handoff" },
    runSignal: runAbort.signal,
    sessionManager: manager,
    subscription: { runToolLifecycle },
    // Match the real attempt's retirement of presentation after its run aborts.
    isCurrent: () => !runAbort.signal.aborted,
    isReplaySafeTool: () => false,
    nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
  });
  try {
    await consume({
      subscription,
      manager,
      execute: (input, signal) =>
        executor({
          tool,
          toolName: tool.name,
          source: "openclaw",
          sourceName: "core",
          toolCallId: `nested-${tool.name}`,
          parentToolCallId: "dispatch-action",
          input,
          signal,
          acceptResultBeforeProjection: async (result) => result,
        }),
    });
  } finally {
    await Promise.allSettled(pending);
    subscription.unsubscribe();
  }
}

it.for(["ask_user", "sessions_yield"] as const)(
  "preserves the native %s handoff through the subscribed executor",
  async (name) => {
    const runAbort = new AbortController();
    const handoff = () => runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method !== "question.request") {
        throw new Error(`Unexpected question operation: ${method}`);
      }
      return { id: params.id, durable: true };
    });
    const tool =
      name === "ask_user"
        ? createAskUserTool({ gatewayCall: gateway.call, nativeQuestionHandoff: handoff })
        : createSessionsYieldTool({
            sessionId: "requester",
            claimYield: () => true,
            onYield: handoff,
          });
    await withExecutor(tool, runAbort, async ({ execute, subscription, manager }) => {
      expect(await execute(name === "ask_user" ? validArgs : {})).toMatchObject({
        details: { status: name === "ask_user" ? "waiting" : "yielded" },
      });
      expect(runAbort.signal.aborted).toBe(true);
      expect(subscription.toolMetas).toMatchObject([{ toolName: name, isError: false }]);
      // Retirement suppresses presentation; it must not turn the completed handoff into failure.
      expect(manager.getEntries()).toEqual([]);
    });
  },
);

it.for(["ordinary-run-abort", "per-call-handoff", "same-name-lookalike"] as const)(
  "retains cancellation for %s in the subscribed executor",
  async (kind) => {
    const runAbort = new AbortController();
    const callerAbort = new AbortController();
    const handoff = () => {
      if (kind === "per-call-handoff") {
        callerAbort.abort(SESSIONS_YIELD_ABORT_REASON);
      } else {
        runAbort.abort(
          kind === "ordinary-run-abort" ? new Error("User cancelled") : SESSIONS_YIELD_ABORT_REASON,
        );
      }
    };
    const tool =
      kind === "same-name-lookalike"
        ? {
            ...createStubTool("sessions_yield"),
            execute: async () => {
              handoff();
              return { content: [], details: { status: "yielded" } };
            },
          }
        : createSessionsYieldTool({
            sessionId: "requester",
            claimYield: () => true,
            onYield: handoff,
          });
    await withExecutor(tool, runAbort, async ({ execute }) => {
      await expect(execute({}, callerAbort.signal)).rejects.toMatchObject({ name: "AbortError" });
    });
  },
);
