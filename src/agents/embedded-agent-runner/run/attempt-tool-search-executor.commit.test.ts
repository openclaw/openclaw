import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { readAttemptNestedToolActivity } from "./attempt-nested-tool-activity.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

afterEach(() => vi.restoreAllMocks());

it.each(["accepted", "rejected", "superseded"] as const)(
  "retains effect evidence while holding terminal presentation for %s activity",
  async (outcome) => {
    const manager = SessionManager.inMemory();
    const append = manager.appendMessageAsync.bind(manager);
    const reachedAppend = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    const persistenceError = new Error("activity persistence failed");
    const rejected = outcome === "rejected";
    vi.spyOn(manager, "appendMessageAsync").mockImplementation(async (...args) => {
      reachedAppend.resolve();
      await releaseAppend.promise;
      if (rejected) {
        throw persistenceError;
      }
      return append(...args);
    });
    const terminalEvents: string[] = [];
    const committed = () =>
      manager
        .getEntries()
        .some(
          (entry) => entry.type === "message" && Boolean(readNestedToolActivity(entry.message)),
        );
    const { subscription } = createSubscribedSessionHarness({
      runId: "nested-commit-" + outcome,
      onAgentEvent: (event) => {
        if (
          (event.stream === "tool" && event.data.phase === "result") ||
          (event.stream === "item" && event.data.phase === "end")
        ) {
          terminalEvents.push(`${event.stream}:${committed()}`);
        }
      },
    });
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Wrote synthetic result" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      ...createStubTool("write"),
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute,
    };
    let current = true;
    const nestedToolActivityState = { scopeId: "scope", successfulToolNames: new Set<string>() };
    const executor = createSubscribedToolSearchExecutor({
      attempt: { runId: "nested-commit-" + outcome, sessionKey: "key" },
      runSignal: new AbortController().signal,
      sessionManager: manager,
      subscription,
      isCurrent: () => current,
      isReplaySafeTool: () => false,
      nestedToolActivityState,
    });
    try {
      const completion = executor({
        tool,
        toolName: "write",
        source: "openclaw",
        sourceName: "core",
        toolCallId: "nested-write",
        parentToolCallId: "outer-code-mode",
        input: { path: "synthetic.txt", content: "result" },
        acceptResultBeforeProjection: async (result) => result,
      });
      const settled = completion.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await reachedAppend.promise;
      expect(subscription.getReplayState()).toMatchObject({
        replayInvalid: true,
        hadPotentialSideEffects: true,
      });
      expect(subscription.toolMetas).toMatchObject([
        { toolCallId: "nested-write", parentToolCallId: "outer-code-mode", isError: false },
      ]);
      expect(terminalEvents).toEqual([]);
      if (outcome === "superseded") {
        current = false;
      }
      releaseAppend.resolve();
      if (rejected) {
        expect(await settled).toEqual({ error: persistenceError });
        expect(subscription.getReplayState().replayInvalid).toBe(true);
      } else {
        expect(await settled).toHaveProperty("result");
      }
      expect(terminalEvents).toEqual(outcome === "accepted" ? ["item:true", "tool:true"] : []);
      expect(await readAttemptNestedToolActivity(manager, nestedToolActivityState)).toMatchObject(
        rejected ? [] : [{ details: { toolCallId: "nested-write", toolName: "write" } }],
      );
      expect([...nestedToolActivityState.successfulToolNames]).toEqual(rejected ? [] : ["write"]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      releaseAppend.resolve();
      subscription.unsubscribe();
    }
  },
);
