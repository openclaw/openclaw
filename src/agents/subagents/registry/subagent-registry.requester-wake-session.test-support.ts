import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { getRuntimeConfig, type OpenClawConfig } from "../../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import type { onAgentEvent } from "../../../infra/agent-events.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as announceRuntime from "../announce/subagent-announce.runtime.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createExternalRequesterSessionEntry } from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

export function pendingRequesterSettleWake(
  runId: string,
  batchRunIds = [runId],
): NonNullable<SubagentRunRecord["requesterSettleWake"]> {
  return {
    status: "pending",
    attemptCount: 0,
    batchRunIds,
    requesterYieldBatch: true,
    rearmGeneration: 1,
    progressOperationId: runId,
  };
}

export function holdRequesterWakeResponses(
  gates: ReadonlyMap<string, Promise<void>>,
  emptyReply: () => boolean,
) {
  const mockDispatch = vi.mocked(announceRuntime.dispatchGatewayMethodInProcess);
  const dispatch = mockDispatch.getMockImplementation();
  if (!dispatch) {
    throw new Error("Requester fixture requires its controller-admitting Gateway adapter");
  }
  mockDispatch.mockImplementation(async (method, params, options) => {
    const result = await dispatch(method, params, options);
    const sourceSessionKey = isRecord(params.inputProvenance)
      ? params.inputProvenance.sourceSessionKey
      : undefined;
    const gate =
      method === "agent" && typeof sourceSessionKey === "string"
        ? gates.get(sourceSessionKey)
        : undefined;
    if (gate) {
      // Delay the transport response only after the actual controller turn has completed.
      await gate;
      if (emptyReply()) {
        return { result: { payloads: [] } };
      }
    }
    return result;
  });
}

export function createGatewayContext() {
  const lifecycleRuntime: GatewayRequestContext["lifecycleRuntime"] = {
    dispatchAgent: (params, timeoutMs) => callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params, timeoutMs, signal) =>
      callGateway({ method: "agent.wait", params, timeoutMs, signal }),
    dispatchSessionMethod: (method, params, options) =>
      callGateway({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      }),
    sendNotice: async () => {
      throw new Error("Unexpected lifecycle notice");
    },
  };
  const methodRegistry = createRequestGatewayMethodRegistry();
  const context = Object.assign(
    createGatewayRequestContext(
      makeContextParams({ getAttachedGatewayMethodRegistry: () => methodRegistry }),
    ),
    { lifecycleRuntime, localEmbedded: true },
  );
  context.resolveGatewayContext = () => context;
  return context;
}

export type RequesterWakeFixture = ReturnType<typeof createRequesterWakeSessionFixture> & {
  requesterSessionKey: string;
  createGatewayContext: typeof createGatewayContext;
  getFixture: () => {
    testState: OpenClawTestState;
    sessionStore: Record<string, SessionStoreEntry>;
    sessionStorePath: string;
  };
  emitCompleted: (
    runId: string,
    sessionKey: string,
    text: string,
    modelRouteChange?: string,
  ) => void;
  flushOwnedWork: () => Promise<void>;
  waitForDeliveredCleanup: (
    runId: string,
    options?: { allowPendingRequesterSettleWake?: boolean },
  ) => Promise<void>;
  waitForAgentCallCount: (count: number) => Promise<void>;
  getRequesterWakeCalls: () => GatewayRequest[];
  getAgentCalls: () => GatewayRequest[];
  getLifecycleHandler: () => Parameters<typeof onAgentEvent>[0] | undefined;
  wakeRequester: typeof maybeWakeRequesterAfterAllChildrenSettled;
};

export function createRequesterWakeSessionFixture(params: {
  requesterSessionKey: string;
  getSessionStore: () => Record<string, SessionStoreEntry>;
  getSessionStorePath: () => string;
}) {
  const prepareChildSession = async (
    childSessionKey: string,
    sessionId: string,
    updatedAt = Date.now(),
  ) => {
    const scope = {
      agentId: "main",
      storePath: params.getSessionStorePath(),
      sessionKey: childSessionKey,
    };
    await replaceSessionEntry(scope, { sessionId, lifecycleRevision: "original", updatedAt });
    const entry = loadExactSessionEntryReadOnly(scope)?.entry;
    if (!entry) {
      throw new Error("Requester wake fixture did not persist its child session");
    }
    params.getSessionStore()[childSessionKey] = entry;
    return entry;
  };

  const spawnVisibleChild = async ({
    runId,
    childSessionKey,
    requesterTurnRunId,
  }: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => {
    const sessionEntry = await prepareChildSession(childSessionKey, `sess-${runId}`);
    const result = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: `finish ${runId}`,
      label: runId,
      runtime: "subagent",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: params.requesterSessionKey,
        requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { entries: { main: {} } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: childSessionKey,
          sessionId: sessionEntry.sessionId,
          entry: sessionEntry,
          runStarted: true,
          runId,
        })) as never,
        registerRun: registry.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(result).toMatchObject({ status: "accepted", runId });
  };

  const settleTurn = async (
    runId: string,
    acceptedSessionSpawns: AcceptedSessionSpawn[],
    yielded = true,
  ) => {
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    return withLocalSessionPlacementTurnSettlement(
      { sessionId: "sess-main", sessionKey: params.requesterSessionKey, agentId: "main", runId },
      async () => ({
        payloads: [],
        acceptedSessionSpawns,
        meta: {
          durationMs: 1,
          yielded,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
  };
  return { prepareChildSession, spawnVisibleChild, settleTurn };
}

export async function prepareLargeRequesterWakeFixture(
  params: { sessionStore: Record<string, SessionStoreEntry>; sessionStorePath: string },
  nested: boolean,
) {
  vi.setSystemTime(100_000);
  const cfg: OpenClawConfig = {
    ...getRuntimeConfig(),
    logging: { audit: { enabled: true, executionIdentity: true } },
  };
  setRuntimeConfigSnapshot(cfg);
  vi.mocked(getRuntimeConfig).mockReturnValue(cfg);
  const requesterSessionKey = "agent:main:telegram:direct:1234567890";
  params.sessionStore[requesterSessionKey] = createExternalRequesterSessionEntry();
  await replaceSessionEntry(
    { storePath: params.sessionStorePath, sessionKey: requesterSessionKey },
    params.sessionStore[requesterSessionKey],
  );
  const context = createGatewayContext();
  await registry.initSubagentRegistry();
  await registry.activateSubagentRegistry(() => context);
  const fixture = createRequesterWakeSessionFixture({
    requesterSessionKey,
    getSessionStore: () => params.sessionStore,
    getSessionStorePath: () => params.sessionStorePath,
  });
  const childIds = Array.from(
    { length: nested ? 3 : 6 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const nestedSessionKey = "agent:main:subagent:10000000-0000-4000-8000-000000000000";
  const children = nested
    ? [
        {
          runId: buildRequesterSettleWakeIdentity({
            requesterSessionKey: nestedSessionKey,
            requesterAgentId: "main",
            batchRunIds: childIds,
            rearmGeneration: 1,
          }).runId,
          childSessionKey: nestedSessionKey,
          expectsCompletionMessage: true,
        },
      ]
    : childIds.map((runId) => ({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        expectsCompletionMessage: true,
      }));
  return { cfg, requesterSessionKey, fixture, children };
}

export function expectLargeRequesterWakeFindings(
  request: GatewayRequest | undefined,
  count: number,
) {
  const findings = request?.params?.internalEvents?.[0]?.result ?? request?.params?.message;
  for (let index = 0; index < count; index++) {
    expect(findings).toContain(`findings ${index}`);
  }
}
