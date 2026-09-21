import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import * as internalSessionEffects from "../../internal-session-effects.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

it.each(["completed", "failed"] as const)(
  "retains replacement transcript cleanup through restart until it has %s",
  async (outcome) => {
    vi.spyOn(subagentRegistryDeps, "callGateway").mockResolvedValue({ status: "pending" });
    const childSessionKey = "agent:main:subagent:steer";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "steer-session",
    });
    registerSubagentRun({
      runId: "run-old",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
    });
    const previous = subagentRuns.get("run-old")!;
    const transcriptTarget = {
      agentId: "main",
      sessionId: "internal-run-old",
      sessionKey: "agent:main:internal-session-effects:run-old",
      storePath,
    };
    previous.execution = { status: "interrupted", transcriptTarget };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
    await settleSubagentRegistryPersistenceWork();

    const cleanup = createDeferred();
    const remove = vi
      .spyOn(internalSessionEffects, "removeInternalSessionEffectsSession")
      .mockImplementationOnce(() => cleanup.promise);
    try {
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        // Replacement is already admitted when the restart fence closes.
        markGatewayRestartDraining();
        expect(
          replaceSubagentRunAfterSteerCore({
            previousRunId: "run-old",
            nextRunId: "run-new",
            fallback: previous,
          }),
        ).toBe(true);
      });

      expect(subagentRuns.has("run-old")).toBe(false);
      expect(subagentRuns.get("run-new")?.execution.status).toBe("running");
      expect(remove).toHaveBeenCalledWith(transcriptTarget);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      if (outcome === "failed") {
        cleanup.reject(new Error("private transcript cleanup failed"));
      } else {
        cleanup.resolve();
      }
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      cleanup.resolve();
      await cleanup.promise.catch(() => {});
      resetGatewayWorkAdmission();
    }
  },
);
