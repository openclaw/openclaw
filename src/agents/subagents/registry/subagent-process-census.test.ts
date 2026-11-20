import { afterEach, expect, it } from "vitest";
import { findLeakedSubagentProcesses } from "../../../../test/subagent-process-census.js";
import { markCancellationRequested } from "../../bash-process-registry.js";
import { registerProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import "./subagent-registry.js";

const childSessionKey = "agent:main:subagent:census";

afterEach(() => {
  subagentRuns.clear();
  resetProcessRegistryForTests();
});

// Rows are seeded without a publication, so the task-end stop never runs: the leak a test can leave.
it.each([
  { row: "ended", endedAt: 2, leaks: true },
  { row: "still running", endedAt: undefined, leaks: false },
])("the shared teardown census reports a process of an $row subagent: $leaks", (row) => {
  subagentRuns.set(
    "census-run",
    createSubagentRunRecord({
      runId: "census-run",
      childSessionKey,
      startedAt: 1,
      endedAt: row.endedAt,
      outcome: row.endedAt ? { status: "ok" } : undefined,
    }),
  );
  const session = registerProcessSessionFixture({
    id: "census-process",
    scopeKey: childSessionKey,
    backgrounded: true,
    startedAt: 1,
  });
  expect(findLeakedSubagentProcesses().map(({ command }) => command)).toEqual(
    row.leaks ? [session.command] : [],
  );
  // A requested stop owns the process; the census leaves it to that stop.
  markCancellationRequested(session);
  expect(findLeakedSubagentProcesses()).toEqual([]);
});
