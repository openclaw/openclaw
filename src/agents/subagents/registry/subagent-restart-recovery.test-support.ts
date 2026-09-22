// Shared real-registry and SQLite fixture for restart ownership integration tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import "./subagent-registry.persistence.mocks.test-support.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { captureTaskDeliveryWork } from "../../../tasks/task-registry-delivery.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import {
  createCanonicalSubagentRunFixture,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import {
  activateSubagentRegistry,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../announce/subagent-announce.js", async (importOriginal) => {
  const { hasUsableSessionEntry } =
    await importOriginal<typeof import("../announce/subagent-announce.js")>();
  return {
    hasUsableSessionEntry,
    captureSubagentCompletionReply: vi.fn(async () => undefined),
    runSubagentAnnounceFlow: vi.fn<
      typeof import("../announce/subagent-announce.js").runSubagentAnnounceFlow
    >(async () => "delivered"),
  };
});
vi.mock("../../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/agent-events.js")>();
  return { ...actual, onAgentEvent: vi.fn(actual.onAgentEvent) };
});

export function makeRestartRecoveryRun(
  overrides: Partial<SubagentRunRecordOverrides>,
): SubagentRunRecord {
  return createCanonicalSubagentRunFixture(
    createSubagentRunRecord({
      runId: "run",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "restart-recoverable work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
      ...overrides,
    }),
  );
}

export function useSubagentRestartRecoveryFixture() {
  const dispatchAgent = vi.fn();
  const gatewayRuntime: GatewayRecoveryRuntime = {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
    waitForAgent: vi.fn(async () => ({
      status: "pending",
    })) as GatewayRecoveryRuntime["waitForAgent"],
    sendRecoveryNotice: vi.fn(),
  };
  const activateGatewayRuntime = () => {
    const gatewayContext = {
      recoveryRuntime: gatewayRuntime,
      resolveGatewayContext: () => gatewayContext as never,
    };
    bindGatewayContextResolver(gatewayRuntime, gatewayContext.resolveGatewayContext);
    activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  };

  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;
  let deliveries: ReturnType<typeof captureTaskDeliveryWork> | undefined;
  const settle = () => settleSubagentRegistryPersistenceWork(deliveries);

  beforeEach(async () => {
    // Retained stores still belong to the previous case until its cleanup succeeds.
    if (tempStateDir !== null) {
      throw new Error("Previous restart recovery fixture cleanup is incomplete");
    }
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-integ-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    setRuntimeConfigSnapshot({ session: { store: undefined } } as never);
    vi.mocked(runSubagentAnnounceFlow).mockReset();
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
    vi.mocked(onAgentEvent).mockImplementation(() => () => undefined);
    deliveries = captureTaskDeliveryWork();
    activateGatewayRuntime();
    dispatchAgent.mockReset();
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await settle();
    } catch (error) {
      failures.push(error);
    }
    // Preserve stores and their environment while detached delivery still owns them.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        resetSubagentRegistryForTests({ persist: false });
        await cleanupSessionStateForTest({ stateDir: tempStateDir ?? undefined });
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        clearRuntimeConfigSnapshot();
        if (tempStateDir) {
          await fs.rm(tempStateDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
          });
        }
        envSnapshot.restore();
        deliveries?.[Symbol.dispose]();
        deliveries = undefined;
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
      throw new AggregateError(failures, "Subagent restart recovery cleanup failed");
    }
  });

  return {
    settle,
    activateGatewayRuntime,
    dispatchAgent,
    gatewayRuntime,
    get stateDir(): string {
      if (!tempStateDir) {
        throw new Error("Restart recovery fixture has not initialized its state directory");
      }
      return tempStateDir;
    },
  };
}
