// Preserve registry fixture setup before importing its consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  clearTestEmbeddedRun as clearRun,
  registerTestEmbeddedRun as attachRun,
  createEmbeddedRunHandle,
} from "../../embedded-agent-runner/runs.test-support.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { addSubagentRunForTests, getSubagentRunByRunId } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

type IdentityCase = [
  name: string,
  recorded: string | undefined,
  current: string,
  killed: boolean,
  expected?: string,
  removeCurrent?: boolean,
  expectedKey?: string,
];
const otherChild = "agent:main:subagent:other-child";
it.each<IdentityCase>([
  ["matching current", "original", "original", true],
  ["conflicting current", "stale", "original", false],
  ["missing current; original running", "original", "original", true, undefined, true],
  ["matching expected; newer current", "original", "replacement", true, "original"],
  ["conflicting expected; matching current", "stale", "stale", false, "original"],
  ["fully legacy", undefined, "replacement", true, "original"],
  // Another child's target is inapplicable; the worker-read current session decides.
  ["other child's target", "original", "original", true, "other", false, otherChild],
])(
  "checks legacy Stop identity: %s",
  async (_name, recorded, current, killed, expected, removeCurrent, expectedKey) => {
    const sessionKey = "agent:main:subagent:legacy-stop";
    const runId = "legacy-stop";
    const disk = { stateDir: fixture.stateDir, agentId: "main", sessionKey };
    const storePath = await writeSubagentSessionEntry({ ...disk, defaultSessionId: current });
    if (removeCurrent) {
      await removeSubagentSessionEntry(disk);
    }
    await addSubagentRunForTests({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      requesterSessionKey: "agent:main:main",
      childSessionIdentity: recorded ? { sessionId: recorded } : undefined,
      execution: {
        status: "running",
        transcriptTarget: expected
          ? {
              agentId: "main",
              sessionKey: expectedKey ?? sessionKey,
              sessionId: expected,
              storePath,
            }
          : undefined,
      },
    });
    const before = structuredClone(getSubagentRunByRunId(runId));
    const scope = { agentId: "main", storePath, sessionKey };
    const sessionBefore = loadSessionEntry(scope);
    const activeId = expectedKey ? current : (expected ?? current);
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    abort.mockImplementation(() => clearRun(activeId, handle, sessionKey));
    const nativeTarget = { storeScope: storePath };
    attachRun(activeId, handle, sessionKey, undefined, "main", undefined, undefined, nativeTarget);
    try {
      const result = await killSubagentRunAdmin({
        cfg: { session: { store: storePath } },
        sessionKey,
        agentId: "main",
        expectedRunId: runId,
      });
      expect(result).toMatchObject({ found: true, killed, cascadeKilled: 0 });
      expect(abort).toHaveBeenCalledTimes(killed ? 1 : 0);
      if (killed) {
        expect(getSubagentRunByRunId(runId)).toMatchObject({
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          execution: { status: "terminal", suppressSessionEffects: true },
        });
      } else {
        expect(result).toHaveProperty(
          "error",
          expect.stringContaining("incarnation is unresolved or changed"),
        );
        expect(getSubagentRunByRunId(runId)).toEqual(before);
      }
      expect(loadSessionEntry(scope)).toEqual(sessionBefore);
      expect(fixture.cleanup).not.toHaveBeenCalled();
    } finally {
      clearRun(activeId, handle, sessionKey);
    }
  },
);
