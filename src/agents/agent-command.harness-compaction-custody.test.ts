import { expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../config/sessions/restart-recovery-state.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { enqueueDeliveryOnce } from "../infra/outbound/delivery-queue-storage.js";
import { loadPendingDeliveries } from "../infra/outbound/delivery-queue.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  compactionTestRuntime,
  compactionTestState as state,
  makeCompactionResult,
} from "./agent-command.compaction.test-support.js";
import {
  createCustodyFixture,
  registerCustodyHooks,
} from "./agent-command.custody.test-support.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "./agent-harness-completion-scope.js";
import { runWithAgentToolSourceExecutionScope } from "./agent-tool-source-execution-guard.js";

registerCustodyHooks();

it.each(
  (["embedded", "postrun"] as const).flatMap((phase) =>
    (["live", "recovery"] as const).flatMap((mode) =>
      (["owed", "revoked", "rebind", "task", "lifecycle"] as const).map((variant) => ({
        phase,
        mode,
        variant,
      })),
    ),
  ),
)(
  "preserves actual harness admission through $phase compaction ($mode, $variant)",
  async ({ phase, mode, variant }) => {
    const { acceptCompactionSuccessor, patchSessionEntryCore } = compactionTestRuntime;
    const fixture = await createCustodyFixture("agent:main:dashboard:harness-compaction", {
      lifecycleRevision: "generation",
    });
    const { sessionId, sessionKey, stateDir, target, entry, recover } = fixture;
    const sourceRunId = "announce:harness-compaction";
    const taskRunId = "harness-child";
    let revoked = false;
    let source: SessionSourceAssertion | undefined;
    let originalClaim: NonNullable<ReturnType<typeof entry>>["restartRecoveryHarnessCompletion"];
    let acceptedCount = 0;
    let attemptedRefusal = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("original source revoked");
      }
    };
    const accept = async (
      assertActive: SessionSourceAssertion,
      onCommitted?: Parameters<typeof acceptCompactionSuccessor>[0]["onCommitted"],
    ) => {
      const current = entry();
      if (!current?.restartRecoveryHarnessCompletion) {
        throw new Error("missing admitted harness claim");
      }
      expect(current.restartRecoveryHarnessCompletion).toMatchObject({
        sessionId,
        taskRunId,
        sourceRunId,
      });
      originalClaim = { ...current.restartRecoveryHarnessCompletion };
      const held = await assertActive.prepareSessionSourceScope?.();
      let accepted: Awaited<ReturnType<typeof acceptCompactionSuccessor>>;
      try {
        accepted = await fixture.accept("successor", assertActive, onCommitted, current);
        expect(held).toBeDefined();
        expect(() => held!.assertCurrent()).toThrow();
      } finally {
        await held?.release?.();
      }
      acceptedCount++;
      expect(accepted.entry.restartRecoveryHarnessCompletion).toEqual({
        ...originalClaim,
        sessionId: "successor",
      });
      if (variant === "rebind") {
        await patchSessionEntryCore(target, () => ({ sessionId: "unauthorized" }));
      }
      if (variant === "task") {
        await patchSessionEntryCore(target, (bound) => ({
          restartRecoveryHarnessCompletion: {
            ...bound.restartRecoveryHarnessCompletion!,
            taskRunId: "other-child",
          },
        }));
      }
      if (variant === "lifecycle") {
        await patchSessionEntryCore(target, () => ({ lifecycleRevision: "unrelated-generation" }));
      }
      if (variant === "revoked") {
        revoked = true;
      }
      return accepted;
    };
    const checkSource = async () => {
      if (!source) {
        throw new Error("missing real harness source authority");
      }
      const assertion = source;
      await runWithAgentToolSourceExecutionScope(assertion, async () => {
        assertion();
      });
    };
    const checkAfterCompaction = () =>
      variant === "owed" ? checkSource() : expect(checkSource()).rejects.toThrow();
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      source = params.opts.assertSourceCurrent;
      expect(source?.prepareSessionSourceScope).toBeTypeOf("function");
      await checkSource();
      if (phase === "embedded") {
        const accepted = await accept(source!);
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 1,
          previousSessionId: accepted.previousSessionId,
          hostCompactionCommitted: true,
          admissionTransitions: [accepted.admissionTransition!],
          target: {
            ...accepted.sessionTarget,
            lifecycleRevision: accepted.entry.lifecycleRevision,
            activeWriterRunId: accepted.entry.activeWriterRunId,
          },
        });
        await checkAfterCompaction();
      }
      return makeCompactionResult({
        sessionId: params.sessionId,
        text: "original final",
        runner: phase === "postrun" ? "cli" : "embedded",
      });
    });
    if (phase === "postrun") {
      state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params, host) => {
        if (!host.assertActive) {
          throw new Error("missing post-run source assertion");
        }
        const accepted = await accept(host.assertActive, host.onCommitted);
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = accepted.entry;
        }
        await checkAfterCompaction();
        return accepted.entry;
      });
    }
    const send = vi.fn(async () => ({
      messageId: "final-message",
      receipt: {
        platformMessageIds: ["final-message"],
        parts: [{ platformMessageId: "final-message", index: 0, kind: "text" as const }],
        sentAt: 1,
      },
    }));
    const afterCommit = vi.fn();
    const plugin = createOutboundTestPlugin({
      id: "discord",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "discord", messageId: "unexpected-legacy" }),
      },
    });
    plugin.message = {
      send: { text: send, lifecycle: { afterCommit } },
      durableFinal: { capabilities: { text: true, afterCommit: true } },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
    state.deliverAgentCommandResultMock.mockImplementation(async (params) => {
      const completion = resolvePendingFinalDeliveryCompletion(params.payloads);
      if (variant !== "owed") {
        // Post-marker invalidation preserves stale metadata; the real delivery
        // boundary must refuse it rather than relying on metadata deletion.
        if (phase === "embedded") {
          expect(completion).toBeUndefined();
        } else {
          expect(completion).toMatchObject({ sessionId: "successor" });
        }
        const { deliverAgentCommandResult } = await import("./command/delivery.js");
        attemptedRefusal = true;
        const refused = await deliverAgentCommandResult(params);
        expect(refused.deliveryStatus).toMatchObject({ status: "suppressed" });
        return refused;
      }
      await checkSource();
      expect(completion).toMatchObject({ sessionId: "successor" });
      if (!completion) {
        throw new Error("missing effective harness delivery custody");
      }
      expect(entry()?.restartRecoveryHarnessCompletion).toEqual({
        ...originalClaim,
        sessionId: "successor",
      });
      const delivery = fixture.delivery(params.payloads, completion);
      if (mode === "recovery") {
        await enqueueDeliveryOnce(delivery, completion.deliveryId, stateDir);
        await recover();
      } else {
        await fixture.deliver(delivery);
      }
      return { deliverySucceeded: true };
    });
    const command = withAgentHarnessCompletionAdmission(
      {
        scope: createAgentHarnessCompletionScope({
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
        }),
        sourceSessionKey: taskRunId,
        sourceRunId,
        requesterSessionId: sessionId,
        requesterLifecycleRevision: "generation",
        isSourceCurrent: () => !revoked,
      },
      () =>
        fixture.command(sourceRunId, assertCurrent, {
          kind: "inter_session",
          sourceTool: "agent_harness_completion",
          sourceChannel: "internal",
          sourceSessionKey: taskRunId,
        }),
    );
    if (variant === "revoked" || (phase === "embedded" && variant !== "owed")) {
      await expect(command).rejects.toThrow();
    } else {
      await command;
    }
    expect(acceptedCount).toBe(1);
    if (phase === "postrun" && !["owed", "revoked"].includes(variant)) {
      expect(attemptedRefusal).toBe(true);
    }
    const evidence = getRestartRecoveryTerminalDeliveryEvidence(entry(), sourceRunId);
    if (variant === "owed") {
      expect(evidence).toMatchObject({
        harnessCompletion: { ...originalClaim, sessionId: "successor" },
        durableFinalReceipt: { platformMessageId: "final-message" },
      });
    } else {
      expect(evidence?.durableFinalReceipt).toBeUndefined();
    }
    await recover();
    expect(send).toHaveBeenCalledTimes(variant === "owed" ? 1 : 0);
    expect(afterCommit).toHaveBeenCalledTimes(variant === "owed" ? 1 : 0);
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
  },
);
