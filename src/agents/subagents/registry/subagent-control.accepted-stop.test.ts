// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { runWithChatAbortExecution } from "../../../gateway/chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-context-binding.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { withTaskCancellationContext } from "../../../tasks/task-cancellation-context.js";
import { cancelTaskById, findTaskByRunId } from "../../../tasks/task-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated, registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it.each(["abort", "interruption", "replacement", "already terminal"] as const)(
  "retains only this accepted Stop after caller revocation during the raw join (%s)",
  async (mode) => {
    const sessionKey = "agent:main:subagent:accepted-stop";
    const sessionId = "accepted-stop-session";
    const runId = "accepted-stop-run";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
    });
    registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "retain the selected cancellation outcome",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const entry = subagentRuns.get(runId)!;
    const task = findTaskByRunId(runId)!;
    const context = createDirectChatContext({ getRuntimeConfig });
    bindGatewayContextResolver(entry, () => context);
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionKey,
      sessionId,
      kind: "agent",
      timeoutMs: 60_000,
    });
    const owner = registration.entry!;
    const releaseTail = createDeferred();
    const selectedTail = createDeferred();
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        await releaseTail.promise;
        registration.cleanup();
      },
      registration.cleanup,
    );
    const settlement = owner.executionSettlement!;
    const completion = settlement.completion;
    Object.defineProperty(settlement, "completion", {
      get() {
        selectedTail.resolve();
        return completion;
      },
    });
    const abort = vi.fn(() => registration.controller.abort());
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const admission =
      mode === "interruption"
        ? await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, sessionId],
            assertAllowed: () => {},
            onInterrupt: () => {
              registration.controller.abort();
              admission?.release();
              return { runId };
            },
          })
        : undefined;
    if (mode === "already terminal") {
      expect(markSubagentRunTerminated({ runId, reason: "killed" })).toBe(1);
    }
    let callerAuthorized = true;
    const pending = withTaskCancellationContext(
      () => {
        if (!callerAuthorized) {
          throw new Error("Caller control revoked during raw execution settlement.");
        }
      },
      () => cancelTaskById({ cfg: getRuntimeConfig(), taskId: task.taskId }),
      { selectedTask: task },
    );
    try {
      expect(
        await Promise.race([
          selectedTail.promise.then(() => "tail selected"),
          pending.then(() => "Stop returned"),
        ]),
      ).toBe("tail selected");
      expect(settlement.status).toBe("pending");
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
      expect(owner.controller.signal.aborted).toBe(mode !== "already terminal");
      callerAuthorized = false;
      if (mode === "replacement") {
        context.chatAbortControllers.set(runId, {
          ...owner,
          controller: new AbortController(),
          executionSettlement: undefined,
        });
      }
      releaseTail.resolve();
      const result = await pending;
      expect(result.cancelled).toBe(mode === "abort" || mode === "interruption");
      if (mode === "replacement") {
        expect(result.reason).toContain("execution owner changed");
        expect(context.chatAbortControllers.get(runId)?.controller.signal.aborted).toBe(false);
      } else if (mode === "already terminal") {
        expect(result.reason).toContain("Caller control revoked");
        expect(abort).not.toHaveBeenCalled();
      }
    } finally {
      releaseTail.resolve();
      admission?.release();
      await Promise.allSettled([pending, execution]);
      registration.cleanup();
      context.chatAbortControllers.clear();
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
