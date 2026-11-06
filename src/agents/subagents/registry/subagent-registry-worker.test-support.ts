import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const restore = () => restoreSubagentRunsFromDisk({ runs: subagentRuns });
export const stored = (id: string) => loadSubagentRegistryFromSqlite().get(id);

export function postimages(rows: Iterable<readonly [string, SubagentRunRecord | null]>) {
  return { value: undefined, postimages: new Map(rows) };
}

export function useSubagentRegistryWorkerFixture() {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    openOpenClawStateDatabase();
  });
  beforeEach(() => {
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Restore also reconciles uncertain or source-superseded writes before deleting fixture rows.
    await restore();
    const runIds = [...subagentRuns.keys()];
    if (runIds.length) {
      await mutateSubagentRuns(runIds, () => postimages(runIds.map((runId) => [runId, null])));
    }
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
  });
  afterAll(async () => {
    await state.cleanup();
  });

  return {
    get state() {
      return state;
    },
  };
}

export function entry(
  runId: string,
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:requester",
    createdAt: 1,
    completion: { required: false },
    delivery: { status: "not_required" },
    ...overrides,
  });
}

export async function register(...entries: SubagentRunRecord[]) {
  await mutateSubagentRuns(
    entries.map((row) => row.runId),
    () => postimages(entries.map((row) => [row.runId, row])),
  );
}

export function change(
  runId: string,
  update: Partial<SubagentRunRecord> | ((row: SubagentRunRecord) => void),
  options?: Pick<
    NonNullable<Parameters<typeof mutateSubagentRuns>[2]>,
    "assertCurrent" | "onPublished"
  >,
) {
  return mutateSubagentRuns(
    [runId],
    (rows) => {
      const current = rows.get(runId);
      if (!current) {
        throw new Error("Missing test row");
      }
      const next =
        typeof update === "function" ? structuredClone(current) : { ...current, ...update };
      if (typeof update === "function") {
        update(next);
      }
      return postimages([[runId, next]]);
    },
    options,
  );
}
