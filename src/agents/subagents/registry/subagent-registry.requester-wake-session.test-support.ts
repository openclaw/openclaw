import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import * as announceRuntime from "../announce/subagent-announce.runtime.js";
import type { SessionStoreEntry } from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

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
  const recoveryRuntime: GatewayRequestContext["recoveryRuntime"] = {
    prepareRestartRecovery: () => undefined,
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
    sendRecoveryNotice: async () => {
      throw new Error("Unexpected recovery notice");
    },
    resumeChatInput: async () => {
      throw new Error("Unexpected chat input recovery");
    },
  };
  const methodRegistry = createRequestGatewayMethodRegistry();
  const context = Object.assign(
    createGatewayRequestContext(
      makeContextParams({ getAttachedGatewayMethodRegistry: () => methodRegistry }),
    ),
    { recoveryRuntime, localEmbedded: true },
  );
  context.resolveGatewayContext = () => context;
  return context;
}

export type PrepareRequesterWakeChildSession = ReturnType<
  typeof createRequesterWakeSessionFixture
>["prepareChildSession"];

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

  return { prepareChildSession, spawnVisibleChild };
}
