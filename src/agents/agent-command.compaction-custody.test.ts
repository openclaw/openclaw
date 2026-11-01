import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePendingFinalDeliveryCompletion } from "../auto-reply/reply/pending-final-delivery.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import { recoverPendingDeliveries } from "../infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

registerAgentCommandCompactionTestHooks();
beforeEach(() => {
  if (!state.cfg) {
    throw new Error("missing config");
  }
  setRuntimeConfigSnapshot(state.cfg);
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.unstubAllEnvs();
});

it.each(["ordinary", "embedded", "preflight", "postrun", "twice", "rebind", "revoked"] as const)(
  "retains final transport custody across accepted compaction (%s)",
  async (mode) => {
    const {
      acceptCompactionSuccessor,
      loadSessionEntry,
      replaceSessionEntry,
      patchSessionEntryCore,
    } = compactionTestRuntime;
    const sessionId = "original-session";
    const sessionKey = "agent:main:dashboard:compaction-custody";
    const storePath = requireCompactionStorePath();
    const target = { agentId: "main", sessionKey, storePath };
    const context = { channel: "discord", to: "discord:dm:123" };
    const stateDir = path.dirname(storePath);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1,
    });
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("original source revoked");
      }
    };
    const transitions: SessionAdmissionTransition[] = [];
    const accept = async (next: string) => {
      const entry = loadSessionEntry(target);
      if (!entry) {
        throw new Error("missing predecessor");
      }
      const accepted = await acceptCompactionSuccessor({
        currentTarget: { ...target, sessionId: entry.sessionId },
        currentSessionFile: sessionKey,
        expectedEntry: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: entry.activeWriterRunId,
        },
        assertActive: assertCurrent,
        result: {
          ok: true,
          compacted: true,
          result: { sessionId: next, tokensBefore: 120, tokensAfter: 42 },
        },
      });
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
      });
      if (!completion) {
        throw new Error("missing accepted final custody");
      }
      expect(loadSessionEntry(target)?.pendingFinalDelivery).toMatchObject({
        context,
      });
      const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
      await deliverOutboundPayloads({
        cfg: {},
        ...context,
        payloads: params.payloads,
        deliveryCompletion: completion,
        deliveryIntentId: completion.deliveryId,
        queuePolicy: "required",
      });
      return { deliverySucceeded: true };
    });
    const command = agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId: "run",
        message: "finish original source",
        allowModelOverride: false,
        ...context,
        deliver: true,
        assertSourceCurrent: assertCurrent,
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    if (mode === "revoked") {
      await expect(command).rejects.toThrow("original source revoked");
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    } else {
      await command;
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    }
    const stored = loadSessionEntry(target);
    if (!safe) {
      expect(stored?.pendingFinalDelivery).toBeUndefined();
    }
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
    await recoverPendingDeliveries({
      cfg: {},
      stateDir,
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloads,
    });
    expect(send).toHaveBeenCalledTimes(safe ? 1 : 0);
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
  },
);
