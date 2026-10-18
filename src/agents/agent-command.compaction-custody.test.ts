import { expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../config/sessions/restart-recovery-state.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
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

registerCustodyHooks();

it.each(
  ([false, true] as const).flatMap((recovery) =>
    (
      [
        "ordinary",
        "embedded",
        "preflight",
        "postrun",
        "twice",
        "rebind",
        "source",
        "route",
        "revoked",
      ] as const
    ).map((mode) => ({ recovery, mode })),
  ),
)(
  "retains exact original final custody across accepted compaction ($recovery, $mode)",
  async ({ recovery, mode }) => {
    const { patchSessionEntryCore } = compactionTestRuntime;
    const context = { channel: "discord", to: "discord:dm:123" };
    const fixture = await createCustodyFixture(
      "agent:main:dashboard:compaction-custody",
      recovery
        ? {
            restartRecoveryDeliveryRunId: "run",
            restartRecoveryDeliverySourceRunId: "source",
            restartRecoveryDeliveryContext: context,
          }
        : {},
    );
    const { sessionId, sessionKey, stateDir, target, entry } = fixture;
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("original source revoked");
      }
    };
    const transitions: SessionAdmissionTransition[] = [];
    const accept = async (next: string) => {
      const accepted = await fixture.accept(next, assertCurrent);
      if (accepted.admissionTransition) {
        transitions.push(accepted.admissionTransition);
      }
      return accepted;
    };
    if (mode === "preflight") {
      state.runSessionPreflightCompactionMock.mockImplementationOnce(async (params) => {
        const accepted = await accept("successor");
        params.onCompactionCommitted?.(accepted);
        return accepted.entry;
      });
    }
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      if (mode !== "ordinary" && mode !== "preflight" && mode !== "postrun") {
        let accepted = await accept("successor");
        if (mode === "twice") {
          accepted = await accept("second-successor");
        }
        params.onCompactionAccounting?.({
          kind: "durable",
          count: transitions.length,
          previousSessionId: accepted.previousSessionId,
          hostCompactionCommitted: true,
          admissionTransitions: transitions,
          target: {
            ...accepted.sessionTarget,
            lifecycleRevision: accepted.entry.lifecycleRevision,
            activeWriterRunId: accepted.entry.activeWriterRunId,
          },
        });
      }
      if (mode === "rebind") {
        await patchSessionEntryCore(target, () => ({ sessionId: "unauthorized" }));
      }
      if (mode === "source") {
        await patchSessionEntryCore(target, () => ({
          restartRecoveryDeliverySourceRunId: "other-source",
        }));
      }
      if (mode === "route") {
        await patchSessionEntryCore(target, () => ({
          restartRecoveryDeliveryContext: { channel: "discord", to: "discord:dm:456" },
        }));
      }
      if (mode === "revoked") {
        revoked = true;
      }
      return makeCompactionResult({
        sessionId: params.sessionId,
        text: "original final",
        runner: mode === "postrun" ? "cli" : "embedded",
      });
    });
    if (mode === "postrun") {
      state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params, host) => {
        const accepted = await accept("successor");
        host?.onCommitted?.(accepted);
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = accepted.entry;
        }
        return accepted.entry;
      });
    }
    const send = vi.fn(async () => ({ channel: "discord", messageId: "final-message" }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: { deliveryMode: "direct", sendText: send },
          }),
        },
      ]),
    );
    const safe = ["ordinary", "embedded", "preflight", "postrun", "twice"].includes(mode);
    state.deliverAgentCommandResultMock.mockImplementation(async (params) => {
      const completion = resolvePendingFinalDeliveryCompletion(params.payloads);
      if (!safe) {
        expect(completion).toBeUndefined();
        return { deliverySucceeded: false };
      }
      expect(completion).toMatchObject({
        sessionId:
          mode === "ordinary" ? sessionId : mode === "twice" ? "second-successor" : "successor",
        ...(recovery ? { recoveryRunId: "run" } : {}),
      });
      if (!completion) {
        throw new Error("missing accepted final custody");
      }
      expect(entry()?.pendingFinalDelivery).toMatchObject({
        ...(recovery ? { sourceRunId: "source" } : {}),
        context,
      });
      await fixture.deliver(fixture.delivery(params.payloads, completion));
      return { deliverySucceeded: true };
    });
    const command = fixture.command("run", assertCurrent);
    if (mode === "revoked") {
      await expect(command).rejects.toThrow("original source revoked");
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    } else {
      await command;
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    }
    const stored = entry();
    if (safe && recovery) {
      expect(getRestartRecoveryTerminalDeliveryEvidence(stored, "source")).toMatchObject({
        durableFinalReceipt: { platformMessageId: "final-message" },
      });
    }
    if (!safe) {
      const evidence = getRestartRecoveryTerminalDeliveryEvidence(stored, "source");
      expect(evidence?.durableFinalReceipt).toBeUndefined();
      expect(evidence?.deliveryStatus?.status).not.toBe("sent");
      expect(stored?.pendingFinalDelivery).toBeUndefined();
    }
    await fixture.recover();
    expect(send).toHaveBeenCalledTimes(safe ? 1 : 0);
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
  },
);
