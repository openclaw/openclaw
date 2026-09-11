import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import {
  emitAgentEventForAdmittedRun,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";

describe("subscribeEmbeddedAgentSession unsubscribe tool cleanup", () => {
  it("removes only the unsubscribed run's unfinished tool starts", () => {
    const first = createSubscribedSessionHarness({ runId: "cleanup-first" });
    const second = createSubscribedSessionHarness({ runId: "cleanup-second" });

    first.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "first-tool",
      args: { path: "/tmp/first" },
    });
    second.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "second-tool",
      args: { path: "/tmp/second" },
    });

    expect(countActiveToolExecutions("cleanup-first")).toBe(1);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    first.subscription.unsubscribe();

    expect(countActiveToolExecutions("cleanup-first")).toBe(0);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    second.subscription.unsubscribe();
    expect(countActiveToolExecutions("cleanup-second")).toBe(0);
  });

  it.each([
    { boundary: "tool flush", terminalPhase: "end" },
    { boundary: "terminal hook", terminalPhase: "error" },
    { boundary: "compaction queue", terminalPhase: "end" },
  ] as const)(
    "fences queued and retained events after unsubscribe during $boundary without closing the root",
    async ({ boundary, terminalPhase }) => {
      const runId = `unsubscribe-${terminalPhase}`;
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "subscription-test");
      const release = createDeferred();
      const entered = createDeferred();
      const compactionEnd = {
        type: "compaction_end",
        reason: "threshold",
        outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
      } as const;
      const events: AgentEventRuntimePayload[] = [];
      const stop = onAgentRuntimeEvent((event) => {
        if (event.runId === runId) {
          events.push(event);
        }
      });
      let first: ReturnType<typeof createSubscribedSessionHarness> | undefined;
      let retry: ReturnType<typeof createSubscribedSessionHarness> | undefined;
      try {
        const admittedRunContext = await admission.admit("embedded");
        const root = getAdmittedRunDelegatedAuthority(admittedRunContext);
        if (!root) {
          throw new Error("Expected the actual admitted subscription owner");
        }
        const backstop = createAgentLifecycleTerminalBackstop({
          runId,
          getLifecycleGeneration: () => root.lifecycleGeneration,
          emitEvent: (event) => {
            emitAgentEventForAdmittedRun(event, root);
          },
          resolveTerminationFields: () => ({}),
        });
        const callbacks = vi.fn();
        const common = {
          runId,
          admittedRunContext,
          lifecycleGeneration: root.lifecycleGeneration,
          terminalLifecyclePhase: "finishing" as const,
        };
        first = createSubscribedSessionHarness({
          ...common,
          onAgentEvent: (event) => {
            callbacks(event);
            backstop.note(event);
          },
          ...(boundary !== "terminal hook"
            ? {
                onBlockReplyFlush: () => {
                  entered.resolve();
                  return release.promise;
                },
              }
            : {
                onBeforeLifecycleTerminal: () => {
                  entered.resolve();
                  return release.promise;
                },
              }),
        });
        first.emit({ type: "agent_start" });
        if (boundary !== "terminal hook") {
          first.emit({
            type: "tool_execution_start",
            toolName: "read",
            toolCallId: "held-tool",
            args: { path: "/tmp/held" },
          });
        } else {
          first.emit({ type: "agent_end", messages: [], willRetry: false });
        }
        await entered.promise;
        first.emit(
          boundary === "compaction queue"
            ? compactionEnd
            : {
                type: "tool_execution_start",
                toolName: "read",
                toolCallId: "queued-tool",
                args: { path: "/tmp/queued" },
              },
        );
        first.subscription.unsubscribe();
        const callbackCount = callbacks.mock.calls.length;
        // The existing stub deliberately retains the SDK callback after unsubscribe.
        first.emit({ type: "agent_start" });
        if (boundary === "compaction queue") {
          first.emit(compactionEnd);
        }
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);

        retry = createSubscribedSessionHarness({
          ...common,
          onAgentEvent: backstop.note,
        });
        retry.emit({ type: "agent_start" });
        const beforeRelease = events.slice();
        expect(beforeRelease.map((event) => [event.seq, event.contextClaimId])).toEqual([
          [1, root.claimId],
          [2, root.claimId],
        ]);
        release.resolve();
        await first.subscription.waitForPendingEvents();
        expect(events).toEqual(beforeRelease);
        expect(callbacks).toHaveBeenCalledTimes(callbackCount);
        expect(countActiveToolExecutions(runId)).toBe(0);
        if (boundary === "compaction queue") {
          expect(first.subscription.getCompactionCount()).toBe(0);
          expect(first.subscription.getLastCompactionTokensAfter()).toBeUndefined();
        }

        retry.emit({
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "retry-tool",
          args: { path: "/tmp/retry" },
        });
        expect(
          events.filter((event) => event.stream === "tool").map((event) => event.data.toolCallId),
        ).toEqual(["retry-tool"]);
        retry.subscription.unsubscribe();
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
        backstop.emit(terminalPhase, terminalPhase === "error" ? new Error("Final failure") : {});
        backstop.emit(terminalPhase, {});
        expect(events.filter((event) => event.data.executionSettled === true)).toMatchObject([
          {
            stream: "lifecycle",
            contextClaimId: root.claimId,
            lifecycleGeneration: root.lifecycleGeneration,
            data: { phase: terminalPhase, executionSettled: true },
          },
        ]);
        expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
        admission.close();
        expect(validateAgentRunDelegatedAuthority(root)).toBe(false);
      } finally {
        release.resolve();
        first?.subscription.unsubscribe();
        retry?.subscription.unsubscribe();
        await Promise.allSettled([
          first?.subscription.waitForPendingEvents(),
          retry?.subscription.waitForPendingEvents(),
        ]);
        stop();
        admission.close();
      }
    },
  );
});
