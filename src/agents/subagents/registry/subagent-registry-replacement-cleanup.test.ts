// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import * as internalSessionEffects from "../../internal-session-effects.js";
import {
  addSubagentRunForTests,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
beforeEach(() => captureRuntimeConfigAsyncReader()());

it("retains replacement transcript cleanup through restart and releases it after failure", async () => {
  fixture.gateway.mockResolvedValue({ status: "pending" });
  const childSessionKey = "agent:main:subagent:steer";
  const transcriptTarget = {
    agentId: "main",
    sessionId: "internal-run-old",
    sessionKey: "agent:main:internal-session-effects:run-old",
    storePath: `${fixture.stateDir}/sessions.json`,
  };
  await addSubagentRunForTests({
    runId: "run-old",
    generation: 1,
    childSessionKey,
    childAgentId: "main",
    childSessionIdentity: { sessionId: "steer-session", lifecycleRevision: "steer-revision" },
    execution: { status: "interrupted", transcriptTarget },
  });
  const cleanup = createDeferred();
  const cleanupFailure = new Error("private transcript cleanup failed");
  const remove = vi
    .spyOn(internalSessionEffects, "removeInternalSessionEffectsSession")
    .mockImplementationOnce(() => cleanup.promise);
  try {
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      // Replacement is already admitted when the restart fence closes.
      markGatewayRestartDraining();
      expect(
        await replaceSubagentRunAfterSteerCore({
          previousRunId: "run-old",
          nextRunId: "run-new",
        }),
      ).toBe(true);
    });

    expect(remove).toHaveBeenCalledWith(transcriptTarget);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    cleanup.reject(cleanupFailure);
    await expect(fixture.settle()).rejects.toMatchObject({ errors: [cleanupFailure] });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    cleanup.resolve();
    await cleanup.promise.catch(() => {});
    resetGatewayWorkAdmission();
  }
});
