import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { admissionFixture, countAdmissionBefore } from "./subagent-admission.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  countActiveSubagentRunsForSession as count,
  getSubagentSessionListReadSnapshotIdentity,
} from "./subagent-registry-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});

it("preserves admission counts across durable/live ownership and generation changes without scanning unrelated runs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    const { persisted, live, sessions } = admissionFixture(8);
    persistRegistryFixture(persisted);
    for (const [id, entry] of live) {
      subagentRuns.set(id, entry);
    }
    const compare = () => {
      for (const session of [...sessions, "", "missing"]) {
        for (const options of [
          undefined,
          { collect: true },
          { collect: false },
          { requesterAgentId: "main" },
          { requesterAgentId: "research", collect: true },
        ]) {
          expect(
            count(subagentRuns, session, options),
            `${session} ${JSON.stringify(options)}`,
          ).toBe(countAdmissionBefore(persisted, subagentRuns, session, options));
        }
      }
    };
    compare();
    const moved = persisted.get("0-0")!;
    persisted.set(moved.runId, {
      ...moved,
      swarmRequesterSessionKey: "owner-1",
      controllerSessionKey: "owner-2",
    });
    persisted.delete("1-0");
    persistRegistryFixture(persisted, [moved.runId, "1-0"]);
    subagentRuns.delete(moved.runId);
    subagentRuns.set("0-3", { ...persisted.get("0-3")!, swarmRequesterSessionKey: "owner-2" });
    compare();

    const expected = countAdmissionBefore(persisted, subagentRuns, "owner-0");
    const snapshot = getSubagentSessionListReadSnapshotIdentity();
    expect(snapshot).toBeInstanceOf(Map);
    if (!(snapshot instanceof Map)) {
      throw new Error("Expected the resident durable registry");
    }
    for (const runs of [subagentRuns, snapshot]) {
      vi.spyOn(runs, Symbol.iterator).mockImplementation(() => {
        throw new Error("full registry scan");
      });
      vi.spyOn(runs, "values").mockImplementation(() => {
        throw new Error("full registry scan");
      });
    }
    expect(count(subagentRuns, "owner-0")).toBe(expected);
    vi.restoreAllMocks();
  });
});
