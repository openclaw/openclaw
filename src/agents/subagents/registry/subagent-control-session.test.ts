// Preserve registry fixture setup before importing its consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { addSubagentRunForTests, getSubagentRunByRunId } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

it.each([
  { name: "matching current", recorded: "original", current: "original", killed: true },
  { name: "conflicting current", recorded: "stale", current: "original", killed: false },
  {
    name: "missing current with its original execution still running",
    recorded: "original",
    current: "original",
    removeCurrent: true,
    killed: true,
  },
  {
    name: "matching expected despite a newer current session",
    recorded: "original",
    current: "replacement",
    expected: "original",
    killed: true,
  },
  {
    name: "conflicting expected despite a matching current session",
    recorded: "stale",
    current: "stale",
    expected: "original",
    killed: false,
  },
  { name: "fully legacy", current: "replacement", expected: "original", killed: true },
  {
    // A target for another child key is inapplicable; the worker-read current session decides.
    name: "matching current despite another child's target",
    recorded: "original",
    current: "original",
    expected: "other",
    expectedKey: "agent:main:subagent:other-child",
    killed: true,
  },
])(
  "checks legacy Stop identity: $name",
  async ({ recorded, current, removeCurrent, expected, expectedKey, killed }) => {
    const sessionKey = "agent:main:subagent:legacy-stop";
    const runId = "legacy-stop";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: current,
    });
    if (removeCurrent) {
      await removeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
      });
    }
    await addSubagentRunForTests({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      requesterSessionKey: "agent:main:main",
      childSessionIdentity: recorded ? { sessionId: recorded } : undefined,
      execution: {
        status: "running",
        ...(expected
          ? {
              transcriptTarget: {
                agentId: "main",
                sessionKey: expectedKey ?? sessionKey,
                sessionId: expected,
                storePath,
              },
            }
          : {}),
      },
    });
    const before = structuredClone(getSubagentRunByRunId(runId));
    const scope = { agentId: "main", storePath, sessionKey };
    const sessionBefore = loadSessionEntry(scope);
    const executionSessionId = expectedKey ? current : (expected ?? current);
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    abort.mockImplementation(() => clearActiveEmbeddedRun(executionSessionId, handle, sessionKey));
    setActiveEmbeddedRun(executionSessionId, handle, sessionKey, undefined, "main");
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
      clearActiveEmbeddedRun(executionSessionId, handle, sessionKey);
    }
  },
);
