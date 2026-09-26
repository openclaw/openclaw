import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { isPathInside } from "../../../infra/path-guards.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { listOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => {
  const { hasUsableSessionEntry } =
    await importOriginal<typeof import("../announce/subagent-announce.js")>();
  return {
    hasUsableSessionEntry,
    runSubagentAnnounceFlow: announceSpy,
    captureSubagentCompletionReply: vi.fn(async () => undefined),
  };
});

export { announceSpy };

export function createSubagentPersistenceRuntime(call: typeof callGateway): GatewayRecoveryRuntime {
  return {
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
  registry.activateSubagentRegistry(
    () => ({ resolveGatewayContext: () => ({ recoveryRuntime }) }) as never,
  );
}

export function listFixtureAgentDatabases(
  listDatabases: typeof listOpenClawAgentDatabasesForTest,
  stateDir: string,
) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
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
      listFixtureAgentDatabases(listDatabases, params.stateDir),
      `${label} agent handles closed before fixture removal`,
    ).toEqual([]);
  }
  closeOpenClawStateDatabaseForTest();
  params.closeStateDatabase();
}

export function useSubagentPersistenceFixture() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;
  const settle = () => settleSubagentRegistryPersistenceWork();

  beforeEach(() => {
    // Failed cleanup retains this case's stores and capture until its work retires.
    if (tempStateDir !== null) {
      throw new Error("Previous persistence fixture cleanup is incomplete");
    }
    setRuntimeConfigSnapshot({});
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    resetSubagentPersistenceGatewayCalls(callGateway);
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await settle();
    } catch (error) {
      failures.push(error);
    }
    // Delivery results can settle before their tracked cleanup tails release the stores.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        resetSubagentRegistryForTests({ persist: false });
        if (tempStateDir) {
          await cleanupSessionStateForTest({ stateDir: tempStateDir });
        }
        if (tempStateDir) {
          // Resource cleanup finished; removal failure must not retain a retired owner.
          try {
            await fs.rm(tempStateDir, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 50,
            });
          } catch (error) {
            failures.push(error);
          }
        }
        clearRuntimeConfigSnapshot();
        envSnapshot.restore();
        vi.restoreAllMocks();
        tempStateDir = null;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Subagent persistence cleanup failed");
    }
  });

  return {
    settle,
    async allocateStateDir() {
      if (tempStateDir !== null) {
        throw new Error("Persistence fixture already owns a state directory");
      }
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    },
    get stateDir(): string {
      if (!tempStateDir) {
        throw new Error("Persistence fixture has not initialized its state directory");
      }
      return tempStateDir;
    },
  };
}
