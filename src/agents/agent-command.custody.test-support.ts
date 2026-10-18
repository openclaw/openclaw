import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { recoverPendingDeliveries } from "../infra/outbound/delivery-queue-recovery.js";
import { createRecoveryLog } from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime as runtime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

export function registerCustodyHooks() {
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
}

export async function createCustodyFixture(
  sessionKey: string,
  initial: Partial<SessionEntry> = {},
) {
  const sessionId = "original-session";
  const storePath = requireCompactionStorePath();
  const stateDir = path.dirname(storePath);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const target = { agentId: "main", sessionKey, storePath };
  const context = { channel: "discord", to: "discord:dm:123" };
  await runtime.replaceSessionEntry(target, { sessionId, updatedAt: 1, ...initial });
  const deliver = async (
    ...args: Parameters<typeof import("../infra/outbound/deliver.js").deliverOutboundPayloads>
  ) => (await import("../infra/outbound/deliver.js")).deliverOutboundPayloads(...args);
  return {
    sessionId,
    sessionKey,
    stateDir,
    target,
    entry: () => runtime.loadSessionEntry(target),
    accept: (
      next: string,
      assertActive: SessionSourceAssertion,
      onCommitted?: Parameters<typeof runtime.acceptCompactionSuccessor>[0]["onCommitted"],
      entry = runtime.loadSessionEntry(target),
    ) => {
      if (!entry) {
        throw new Error("missing predecessor");
      }
      return runtime.acceptCompactionSuccessor({
        currentTarget: { ...target, sessionId: entry.sessionId },
        currentSessionFile: sessionKey,
        expectedEntry: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: entry.activeWriterRunId,
        },
        assertActive,
        onCommitted,
        result: {
          ok: true,
          compacted: true,
          result: { sessionId: next, tokensBefore: 120, tokensAfter: 42 },
        },
      });
    },
    command: (
      runId: string,
      assertSourceCurrent: SessionSourceAssertion,
      inputProvenance?: Parameters<typeof agentCommandFromGatewayIngress>[0]["inputProvenance"],
    ) =>
      agentCommandFromGatewayIngress(
        {
          sessionKey,
          sessionId,
          runId,
          message: "original final",
          allowModelOverride: false,
          ...context,
          deliver: true,
          assertSourceCurrent,
          inputProvenance,
        },
        ...GATEWAY_INGRESS_ARGS,
      ),
    delivery: (
      payloads: Parameters<typeof deliver>[0]["payloads"],
      completion: NonNullable<Parameters<typeof deliver>[0]["deliveryCompletion"]>,
    ) => ({
      cfg: {},
      ...context,
      payloads,
      deliveryCompletion: completion,
      deliveryIntentId: completion.deliveryId,
      queuePolicy: "required" as const,
    }),
    deliver,
    recover: () =>
      recoverPendingDeliveries({
        cfg: {},
        stateDir,
        log: createRecoveryLog(),
        deliver,
      }),
  };
}
