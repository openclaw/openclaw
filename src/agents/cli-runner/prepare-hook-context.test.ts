import { expect, it } from "vitest";
import { prepareCliTurnHookContext } from "./prepare-hook-context.js";
import type { RunCliAgentParams } from "./types.js";

it("gives CLI prompt-build hooks the device of a user turn only", async () => {
  const build = async (run: Partial<RunCliAgentParams>) => {
    using resources = new DisposableStack();
    const prepared = await prepareCliTurnHookContext(
      { runId: "run-1", approvalReviewerDeviceId: "device-1", ...run } as RunCliAgentParams,
      {
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        modelId: "model",
        contextTokenBudget: 1000,
        skip: true,
        resources,
      },
    );
    return prepared.promptBuildHookContext.requesterDeviceId;
  };
  await expect(build({ trigger: "user" })).resolves.toBe("device-1");
  await expect(build({ trigger: "cron" })).resolves.toBeUndefined();
});
