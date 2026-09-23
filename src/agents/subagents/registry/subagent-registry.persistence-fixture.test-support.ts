import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { isPathInside } from "../../../infra/path-guards.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import type { listOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.test-support.js";
import { captureTaskDeliveryWork } from "../../../tasks/task-registry-delivery.test-support.js";
import { configureTaskRegistryMaintenance } from "../../../tasks/task-registry.maintenance.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
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

export function listFixtureAgentDatabases(
  listDatabases: typeof listOpenClawAgentDatabasesForTest,
  stateDir: string,
) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
}

export function useSubagentPersistenceFixture() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;
  let deliveries: ReturnType<typeof captureTaskDeliveryWork> | undefined;
  const settle = () => settleSubagentRegistryPersistenceWork(deliveries);

  beforeEach(() => {
    // Failed cleanup retains this case's stores and capture until its work retires.
    if (tempStateDir !== null || deliveries !== undefined) {
      throw new Error("Previous persistence fixture cleanup is incomplete");
    }
    setRuntimeConfigSnapshot({});
    configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({ status: "ok", startedAt: 111, endedAt: 222 });
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
    deliveries = captureTaskDeliveryWork();
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
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
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
        configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
        clearRuntimeConfigSnapshot();
        envSnapshot.restore();
        deliveries?.[Symbol.dispose]();
        vi.restoreAllMocks();
        deliveries = undefined;
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
