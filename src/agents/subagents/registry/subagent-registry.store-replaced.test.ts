import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import {
  records,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function publishCommittedRecords(row: SubagentRunRecord): void {
  seedSubagentCompletionDelivery({ subagent: row });
  subagentRuns.set(row.runId, row);
  publishSubagentRunsAfterAtomicStore(subagentRuns, [row.runId])();
}

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
