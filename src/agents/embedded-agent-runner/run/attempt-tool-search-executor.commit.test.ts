import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

afterEach(() => vi.restoreAllMocks());

describe("nested tool terminal acceptance", () => {
  it.each(["accepted", "rejected", "superseded"] as const)(
    "retains effect evidence while holding terminal presentation for %s activity",
    async (outcome) => {
      const manager = SessionManager.inMemory();
      const append = manager.appendMessageAsync.bind(manager);
      const reachedAppend = Promise.withResolvers<void>();
      const releaseAppend = Promise.withResolvers<void>();
      const persistenceError = new Error("activity persistence failed");
      vi.spyOn(manager, "appendMessageAsync").mockImplementation(async (...args) => {
        reachedAppend.resolve();
        await releaseAppend.promise;
        if (outcome === "rejected") {
          throw persistenceError;
        }
        return append(...args);
      });
      const terminalEvents: Array<{ stream: string; committed: boolean }> = [];
      const { subscription } = createSubscribedSessionHarness({
        runId: "nested-commit-" + outcome,
        onAgentEvent: (event) => {
          if (
            (event.stream === "tool" && event.data.phase === "result") ||
            (event.stream === "item" && event.data.phase === "end")
          ) {
            terminalEvents.push({
              stream: event.stream,
              committed: manager
                .getEntries()
                .some(
                  (entry) =>
                    entry.type === "message" && Boolean(readNestedToolActivity(entry.message)),
                ),
            });
          }
        },
      });
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Wrote synthetic result" }],
        details: {},
      }));
      const tool: AnyAgentTool = {
        name: "write",
        label: "Write",
        description: "Write synthetic result",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute,
      };
      let current = true;
      const executor = createSubscribedToolSearchExecutor({
        attempt: { runId: "nested-commit-" + outcome, sessionKey: "key" },
        runSignal: new AbortController().signal,
        sessionManager: manager,
        subscription,
        isCurrent: () => current,
        isReplaySafeTool: () => false,
        nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
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
        expect(execute).toHaveBeenCalledTimes(1);
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
        if (outcome === "rejected") {
          expect(await settled).toEqual({ error: persistenceError });
          expect(terminalEvents).toEqual([]);
          expect(subscription.getReplayState().replayInvalid).toBe(true);
          expect(subscription.toolMetas).toHaveLength(1);
        } else if (outcome === "superseded") {
          expect(await settled).toHaveProperty("result");
          expect(terminalEvents).toEqual([]);
          expect(manager.getEntries()).toHaveLength(1);
        } else {
          expect(await settled).toHaveProperty("result");
          expect(terminalEvents).toEqual([
            { stream: "item", committed: true },
            { stream: "tool", committed: true },
          ]);
        }
        expect(subscription.getItemLifecycle()).toEqual({
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        releaseAppend.resolve();
        subscription.unsubscribe();
      }
    },
  );
});
