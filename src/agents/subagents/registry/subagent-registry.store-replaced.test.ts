import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { createMockGatewayLifecycleRuntime } from "../../../gateway/server-lifecycle-runtime.test-support.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  records,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { activateSubagentRegistryWithLifecycleRuntime } from "./subagent-registry.activation.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function publishCommittedRecords(row: SubagentRunRecord): void {
  seedSubagentCompletionDelivery({ subagent: row });
  subagentRuns.set(row.runId, row);
  publishSubagentRunsAfterAtomicStore(subagentRuns, [row.runId])();
}

const SUBAGENT_RESTART_INTERRUPTED_ERROR =
  "The Gateway stopped before this subagent finished. Its run did not survive the restart; inspect its saved work before retrying.";

it("settles a running child restored from an earlier Gateway as interrupted", async () => {
  using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const startedBeforeThisProcess = performance.timeOrigin - 60_000;
  const subagent = createSubagentRunRecord({
    runId: "restored-running-child",
    requesterAgentId: "main",
    createdAt: startedBeforeThisProcess,
    startedAt: startedBeforeThisProcess,
    expectsCompletionMessage: true,
  });
  publishCommittedRecords(subagent);
  const terminal = createSubagentRunRecord({
    runId: "restored-terminal-child",
    requesterAgentId: "main",
    createdAt: startedBeforeThisProcess,
    endedAt: startedBeforeThisProcess + 1,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
  });
  publishCommittedRecords(terminal);
  await resetSubagentRegistryForTests({ persist: false });
  await closeOpenClawStateDatabaseAsync();
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const restored = subagentRuns.get(subagent.runId)!;
  expect(restored).toBeDefined();
  expect(subagentRuns.isCompletionAuthorityRetired(restored)).toBe(true);

  await activateSubagentRegistryWithLifecycleRuntime(
    await import("./subagent-registry.test-helpers.js"),
    createMockGatewayLifecycleRuntime(),
  );

  const settled = loadSubagentRegistryFromSqlite().get(subagent.runId);
  expect(warning).toHaveBeenCalledWith(
    "Settling subagent interrupted by Gateway restart",
    expect.objectContaining({ runId: subagent.runId }),
  );
  expect(settled?.execution).toMatchObject({
    status: "terminal",
    outcome: { status: "error", error: SUBAGENT_RESTART_INTERRUPTED_ERROR },
  });
  expect(settled?.endedReason).toBe(SUBAGENT_ENDED_REASON_ERROR);
  expect(loadSubagentRegistryFromSqlite().get(terminal.runId)?.delivery).toMatchObject({
    status: "pending",
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleRootWork: ReturnType<typeof observeRootWork>;
vi.mock("../../../config/config.js", { spy: true });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  settleRootWork = observeRootWork();
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(async () => {
  await settleRootWork();
  await closeOpenClawStateDatabaseAsync();
  await resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  vi.mocked(getRuntimeConfig).mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  "store publication preserves pending completion custody (yielded: %s)",
  async (yielded) => {
    const { subagent } = records();
    subagent.requesterStorePath = "original-store";
    if (yielded) {
      markSubagentRunPausedAfterYield({ entry: subagent });
    }
    publishCommittedRecords(subagent);
    const before = structuredClone(loadSubagentRegistryFromSqlite().get(subagent.runId));
    publishSystemEventStoreResolver(() => "replacement-store");
    await settleRootWork(true);
    expect(subagentRuns.isCompletionAuthorityRetired(subagent)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(subagent.runId)).toEqual(before);
  },
);

it("keeps explicit retirement authoritative after store publication", async () => {
  const { subagent } = records();
  publishCommittedRecords(subagent);
  subagentRuns.retireCompletionAuthority(subagent);
  publishSystemEventStoreResolver(() => "replacement-store");
  await settleRootWork(true);
  expect(() => subagentRuns.runWithCompletionAuthority(subagent, () => "send")).toThrow(
    "source was retired",
  );
  expect(() => subagentRuns.runWithCompletionBatchAuthority([subagent], () => "send")).toThrow(
    "source was retired",
  );
});
