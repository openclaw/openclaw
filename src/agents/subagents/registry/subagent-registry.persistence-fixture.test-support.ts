import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { throwCollectedErrors } from "../../../infra/error-graph-internal.js";
import { isPathInside } from "../../../infra/path-guards.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { listOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce.js")>()),
  runSubagentAnnounceFlow: announceSpy,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));

export { announceSpy };

export function createSubagentPersistenceRuntime(call: typeof callGateway): GatewayRecoveryRuntime {
  return {
    prepareFailedWorkerPlacement: async () => undefined,
    prepareRestartRecovery: () => undefined,
    dispatchSessionMethod: (method, params, options) =>
      call({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      }),
    dispatchAgent: (params, timeoutMs) => call({ method: "agent", params, timeoutMs }),
    waitForAgent: (params, timeoutMs) => call({ method: "agent.wait", params, timeoutMs }),
    sendRecoveryNotice: vi.fn(),
    resumeChatInput: vi.fn(),
  };
}

export function resetSubagentPersistenceGatewayCalls(call: typeof callGateway) {
  vi.mocked(call).mockReset().mockResolvedValue({ status: "ok", startedAt: 111, endedAt: 222 });
}

export function activateSubagentPersistenceRegistry(
  registry: Pick<typeof import("./subagent-registry.test-helpers.js"), "activateSubagentRegistry">,
  call: typeof callGateway,
) {
  const recoveryRuntime = createSubagentPersistenceRuntime(call);
  const gateway = {
    recoveryRuntime,
    resolveGatewayContext: () => gateway as never,
  };
  return registry.activateSubagentRegistry(gateway.resolveGatewayContext).settled;
}

export async function closeSubagentPersistenceFixtureDatabases(params: {
  stateDir: string;
  cleanupSessionState: typeof cleanupSessionStateForTest;
  listAgentDatabases: typeof listOpenClawAgentDatabasesForTest;
  closeStateDatabase: typeof closeOpenClawStateDatabaseForTest;
}) {
  // The resumed registry owns a separate agent-DB cache after resetModules.
  // Agent cleanup releases leases through state DB writes, so close state DBs last.
  await params.cleanupSessionState({ stateDir: params.stateDir });
  for (const [label, listDatabases] of [
    ["seed", listOpenClawAgentDatabasesForTest],
    ["post-reset", params.listAgentDatabases],
  ] as const) {
    expect(
      listDatabases().filter((database) => isPathInside(params.stateDir, database.path)),
      `${label} agent handles closed before fixture removal`,
    ).toEqual([]);
  }
  closeOpenClawStateDatabaseForTest();
  params.closeStateDatabase();
}

export function useSubagentPersistenceFixture() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  const settle = (keepObserving = true) =>
    settleSubagentRegistryPersistenceWork(() => settleRootWork(keepObserving));

  beforeEach(() => {
    // Failed cleanup retains this case's stores and capture until its work retires.
    expect(tempStateDir, "Previous persistence fixture cleanup is incomplete").toBeNull();
    setRuntimeConfigSnapshot({});
    announceSpy.mockReset().mockResolvedValue("delivered");
    resetSubagentPersistenceGatewayCalls(callGateway);
    vi.mocked(onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
    settleRootWork = observeRootWork();
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    await settle(false).catch((error: unknown) => {
      failures.push(error);
    });
    // Delivery results can settle before their tracked cleanup tails release the stores.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        await resetSubagentRegistryForTests({ persist: false });
        if (tempStateDir) {
          await cleanupSessionStateForTest({ stateDir: tempStateDir });
          // Resource cleanup finished; removal failure must not retain a retired owner.
          await fs
            .rm(tempStateDir, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 50,
            })
            .catch((error: unknown) => {
              failures.push(error);
            });
        }
        clearRuntimeConfigSnapshot();
        envSnapshot.restore();
        vi.restoreAllMocks();
        tempStateDir = null;
      } catch (error) {
        failures.push(error);
      }
    }
    throwCollectedErrors(failures, "Subagent persistence cleanup failed");
  });

  return {
    settle,
    async allocateStateDir() {
      expect(tempStateDir, "Persistence fixture already owns a state directory").toBeNull();
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    },
    get stateDir(): string {
      return expectDefined(
        tempStateDir,
        "Persistence fixture has not initialized its state directory",
      );
    },
  };
}
