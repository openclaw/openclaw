// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import * as killSession from "./subagent-control-session.js";
import {
  beginControlAdmission,
  controlController as controller,
  controlSessionKey as key,
  createControlRunFixture,
  expectControlIdle,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./subagent-control.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registryState from "./subagent-registry-state.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const registryRead = await vi.importActual<typeof registryState>("./subagent-registry-state.js");
const fixture = useSubagentControlFixture();
const controlRuns = createControlRunFixture(() => fixture.stateDir);
const owner = "agent:main:main";
const ids = ["root", "child", "healthy"];

async function seed() {
  let storePath = "";
  for (const id of ids) {
    ({ storePath } = await controlRuns.seed(id, {
      requesterSessionKey: id === "root" ? owner : key("root"),
      requesterTurnRunId: id === "root" ? undefined : "root",
      requesterDisplayKey: owner,
      task: "shared label",
      collect: true,
    }));
  }
  return storePath;
}

it.each([
  ["bulk", "root traversal", false],
  ["admin", "root traversal", false],
  ["bulk", "descendant drain", false],
  ["admin", "descendant drain", false],
  ["bulk", "duplicate errors", false],
  ["bulk", "duplicate errors", true],
] as const)(
  "%s accounts for %s (same-text sibling=%s)",
  async (boundary, phase, sameTextSibling) => {
    const storePath = await seed();
    const duplicate = phase === "duplicate errors";
    const entered = createDeferred();
    const held = duplicate ? "root" : "child";
    const admission = await beginControlAdmission(
      storePath,
      key(held),
      `${held}-session`,
      () => {
        entered.resolve();
        return { runId: held };
      },
      held,
    );
    const handles = (duplicate ? ["root", ...(sameTextSibling ? ["healthy"] : [])] : []).map(
      (id) => {
        const handle = createEmbeddedRunHandle({ runId: id, isAbortable: false });
        attachActiveEmbeddedRun(`${id}-session`, handle, key(id));
        return { id, handle };
      },
    );
    const failure = duplicate
      ? "transient root discovery failure"
      : "root identity unavailable after cancellation";
    let armed = false,
      reads = 0,
      failedReads = 0;
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
              failedReads++;
              throw new Error(failure);
            }
            session.assertCurrent();
          },
        };
      });
    const read = registryRead.withSubagentRunReadSnapshot;
    const reader = vi
      .spyOn(registryState, "withSubagentRunReadSnapshot")
      .mockImplementation((runs, select, consume, scope) =>
        read(
          runs,
          select,
          (selection, selected) => {
            if (
              armed &&
              phase !== "root traversal" &&
              selection.sessionKeys.includes(key("root")) &&
              ++reads === 2
            ) {
              if (!duplicate) {
                armed = false;
              }
              failedReads++;
              throw new Error(failure);
            }
            return consume(selection, selected);
          },
          scope,
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
          armed = true;
        }
        return result;
      });
    const cfg = getRuntimeConfig();
    const root = subagentRuns.get("root")!;
    const bulk =
      boundary === "bulk"
        ? killAllControlledSubagentRuns({ cfg, controller, runs: [root] })
        : undefined;
    const pending =
      bulk ??
      killSubagentRunAdmin({
        cfg,
        sessionKey: key("root"),
        expectedRunId: "root",
        expectedOwnerKey: owner,
      });
    try {
      if (phase !== "root traversal") {
        await awaitGateBeforeSettlement(entered.promise, pending, "Root never reached drain");
        if (!duplicate) {
          expect(resolveSubagentSessionStatus(subagentRuns.get("root"))).toBe("killed");
        }
        armed = true;
        admission.release();
      }
      const result = await pending;
      expect(failedReads).toBe(1);
      expect(result).toHaveProperty("error", expect.stringContaining(failure));
      const childKills = phase === "descendant drain" ? 2 : 0;
      const childStatus = childKills ? "killed" : "running";
      expect(ids.map((id) => resolveSubagentSessionStatus(subagentRuns.get(id)))).toEqual(
        duplicate
          ? ["running", "killed", sameTextSibling ? "running" : "killed"]
          : ["killed", childStatus, childStatus],
      );
      if (duplicate) {
        if (!bulk) {
          throw new Error("Duplicate diagnostics require the bulk boundary");
        }
        const diagnostics = await bulk;
        expect(diagnostics).toMatchObject({
          status: "error",
          failed: sameTextSibling ? 2 : 1,
          killed: sameTextSibling ? 1 : 2,
        });
        if (diagnostics.status !== "error") {
          throw new Error("Missing operation diagnostics");
        }
        expect(diagnostics.error.match(/Subagent is still active/g)).toHaveLength(
          sameTextSibling ? 2 : 1,
        );
      } else {
        expect(
          sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: key("root") })?.entry
            .sessionId,
        ).toBe("root-session");
        expect(isSameSubagentRunOwner(subagentRuns.get(root.runId), root)).toBe(true);
        expect(subagentRuns.get(root.runId)?.endedReason).toBe("subagent-killed");
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
      }
    } finally {
      armed = false;
      admission.release();
      try {
        await pending;
      } finally {
        for (const mock of [reader, ownerReader, writer]) {
          mock.mockRestore();
        }
        for (const { id, handle } of handles) {
          await detachActiveEmbeddedRun(`${id}-session`, handle, key(id));
        }
      }
      expectControlIdle();
    }
  },
);
