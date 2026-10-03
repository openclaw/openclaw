// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** Final cancellation diagnostics belong to stable nodes, including the selected root. */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import * as killSession from "./subagent-control-session.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./subagent-control.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const registryRead = await vi.importActual<typeof registryState>("./subagent-registry-state.js");

const fixture = useSubagentControlFixture();
const owner = "agent:main:main";
const key = (id: string) => `agent:main:subagent:${id}`;
const controller = {
  controllerSessionKey: owner,
  controllerAgentId: "main",
  callerSessionKey: owner,
  callerIsSubagent: false,
  controlScope: "children" as const,
};

async function seed() {
  let storePath = "";
  for (const id of ["root", "child", "healthy"]) {
    storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: key(id),
      defaultSessionId: `${id}-session`,
      lifecycleRevision: `${id}-revision`,
    });
    await registerSubagentRun({
      runId: id,
      childSessionKey: key(id),
      requesterSessionKey: id === "root" ? owner : key("root"),
      requesterAgentId: "main",
      requesterDisplayKey: owner,
      task: "shared label",
      cleanup: "keep",
      collect: true,
      expectsCompletionMessage: false,
    });
  }
  return storePath;
}

it.each(
  (["bulk", "admin"] as const).flatMap((boundary) =>
    (["root traversal", "descendant drain"] as const).map((phase) => ({ boundary, phase })),
  ),
)(
  "$boundary reports a root read failure during $phase with truthful kill accounting",
  async ({ boundary, phase }) => {
    const storePath = await seed();
    const entered = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("child"), "child-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const failure = "root identity unavailable after cancellation";
    let armed = false;
    let failedReads = 0;
    let armedReads = 0;
    const prepare = killSession.prepareSubagentKillSession;
    const ownerReader = vi
      .spyOn(killSession, "prepareSubagentKillSession")
      .mockImplementation(async (...args) => {
        const session = await prepare(...args);
        return {
          ...session,
          assertCurrent() {
            if (phase === "root traversal" && armed && args[1] === key("root")) {
              armed = false;
              failedReads += 1;
              throw new Error(failure);
            }
            session.assertCurrent();
          },
        };
      });
    const read = registryRead.withSubagentRunReadSnapshot;
    const reader = vi
      .spyOn(registryState, "withSubagentRunReadSnapshot")
      .mockImplementation((runs, select, consume, readScope) =>
        read(
          runs,
          select,
          (selection, selected) => {
            if (
              armed &&
              phase === "descendant drain" &&
              selection.sessionKeys.includes(key("root")) &&
              ++armedReads === 2
            ) {
              armed = false;
              failedReads += 1;
              throw new Error(failure);
            }
            return consume(selection, selected);
          },
          readScope,
        ),
      );
    const patch = killSession.persistSubagentAbortedLastRun;
    const writer = vi
      .spyOn(killSession, "persistSubagentAbortedLastRun")
      .mockImplementation(async (params) => {
        const result = await patch(params);
        if (
          phase === "root traversal" &&
          params.childSessionKey === key("root") &&
          params.abortedLastRun &&
          result
        ) {
          // The real marker commit has finished; the next root ownership read is fallible.
          armed = true;
        }
        return result;
      });
    const cfg = getRuntimeConfig();
    const root = subagentRuns.get("root")!;
    const pending =
      boundary === "bulk"
        ? killAllControlledSubagentRuns({ cfg, controller, runs: [root] })
        : killSubagentRunAdmin({
            cfg,
            sessionKey: key("root"),
            expectedRunId: "root",
            expectedOwnerKey: owner,
          });
    try {
      if (phase === "descendant drain") {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Root never reached child drain: ${JSON.stringify(result)}`);
          }),
        ]);
        expect(resolveSubagentSessionStatus(subagentRuns.get("root"))).toBe("killed");
        armed = true;
        admission.release();
      }
      const result = await pending;
      expect(failedReads).toBe(1);
      expect(
        sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: key("root") })?.entry
          .sessionId,
      ).toBe("root-session");
      expect(result).toHaveProperty("error", expect.stringContaining(failure));
      const stoppedRoot = subagentRuns.get(root.runId);
      expect(isSameSubagentRunOwner(stoppedRoot, root)).toBe(true);
      expect(stoppedRoot?.endedReason).toBe("subagent-killed");
      const childKills = phase === "descendant drain" ? 2 : 0;
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe(
        childKills ? "killed" : "running",
      );
      expect(resolveSubagentSessionStatus(subagentRuns.get("healthy"))).toBe(
        childKills ? "killed" : "running",
      );
      expect(result).toMatchObject(
        boundary === "bulk"
          ? {
              status: "error",
              killed: 1 + childKills,
              failed: 1,
              labels: Array(1 + childKills).fill("shared label"),
            }
          : {
              found: true,
              killed: true,
              cascadeKilled: childKills,
              targetState: {
                state: "terminal",
                task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
              },
            },
      );
    } finally {
      armed = false;
      admission.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        ownerReader.mockRestore();
        writer.mockRestore();
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each([false, true])(
  "counts failed nodes once despite runtime plus discovery errors (same-text sibling=%s)",
  async (sameTextSibling) => {
    const storePath = await seed();
    const entered = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("root"), "root-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const rootHandle = createEmbeddedRunHandle({ runId: "root", isAbortable: false });
    const healthyHandle = createEmbeddedRunHandle({ runId: "healthy", isAbortable: false });
    setActiveEmbeddedRun("root-session", rootHandle, key("root"));
    if (sameTextSibling) {
      setActiveEmbeddedRun("healthy-session", healthyHandle, key("healthy"));
    }
    const read = registryRead.withSubagentRunReadSnapshot;
    let armed = false;
    let reads = 0;
    let failedReads = 0;
    const failure = "transient root discovery failure";
    const reader = vi
      .spyOn(registryState, "withSubagentRunReadSnapshot")
      .mockImplementation((runs, select, consume, readScope) =>
        read(
          runs,
          select,
          (selection, selected) => {
            if (armed && selection.sessionKeys.includes(key("root")) && ++reads === 2) {
              failedReads += 1;
              throw new Error(failure);
            }
            return consume(selection, selected);
          },
          readScope,
        ),
      );
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller,
      runs: [subagentRuns.get("root")!],
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Root never reached drain: ${JSON.stringify(result)}`);
        }),
      ]);
      armed = true;
      admission.release();
      const result = await pending;
      expect(failedReads).toBe(1);
      expect(result).toMatchObject({
        status: "error",
        failed: sameTextSibling ? 2 : 1,
        killed: sameTextSibling ? 1 : 2,
      });
      if (result.status !== "error") {
        throw new Error("Missing operation diagnostics");
      }
      expect(result.error).toContain(failure);
      // Identical labels and runtime errors on distinct nodes remain distinct diagnostics.
      expect(result.error.match(/Subagent is still active/g)).toHaveLength(sameTextSibling ? 2 : 1);
      expect(resolveSubagentSessionStatus(subagentRuns.get("root"))).toBe("running");
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe("killed");
      expect(resolveSubagentSessionStatus(subagentRuns.get("healthy"))).toBe(
        sameTextSibling ? "running" : "killed",
      );
    } finally {
      armed = false;
      admission.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        clearActiveEmbeddedRun("root-session", rootHandle, key("root"));
        clearActiveEmbeddedRun("healthy-session", healthyHandle, key("healthy"));
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
