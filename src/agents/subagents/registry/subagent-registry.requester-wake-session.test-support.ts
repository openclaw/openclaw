import { expect, vi } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import type { SessionStoreEntry } from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

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
  };
  const context = {
    recoveryRuntime,
    chatAbortControllers: new Map(),
    localEmbedded: true,
  } as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return context;
}

export type PrepareRequesterWakeChildSession = (
  childSessionKey: string,
  sessionId: string,
  updatedAt?: number,
) => Promise<SessionEntry>;

export function createRequesterWakeSessionFixture(params: {
  requesterSessionKey: string;
  getSessionStore: () => Record<string, SessionStoreEntry>;
  getSessionStorePath: () => string;
}) {
  const prepareChildSession: PrepareRequesterWakeChildSession = async (
    childSessionKey,
    sessionId,
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

  const spawnVisibleChild = async (child: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => {
    const sessionEntry = await prepareChildSession(child.childSessionKey, `sess-${child.runId}`);
    const result = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: `finish ${child.runId}`,
      label: child.runId,
      runtime: "subagent",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: params.requesterSessionKey,
        requesterTurnRunId: child.requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { entries: { main: {} } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: child.childSessionKey,
          sessionId: sessionEntry.sessionId,
          entry: sessionEntry,
          runStarted: true,
          runId: child.runId,
        })) as never,
        registerRun: registry.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(result).toMatchObject({ status: "accepted", runId: child.runId });
  };

  return { prepareChildSession, spawnVisibleChild };
}
