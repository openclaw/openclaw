import { afterEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./cli-runner/execute.test-support.js";

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.restoreAllMocks();
});

it.each([undefined, "session-activity-summary", "conversation-label"] as const)(
  "executes purpose %s at the CLI boundary without changing the run trigger",
  async (purpose) => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({ ...createSuccessfulProcessExit(), stdout: "ok" }),
    );
    const context = buildPreparedCliRunContext({ provider: "codex-cli", model: "gpt-test" });
    context.params.trigger = "user";
    context.params.isolatedCompletionPurpose = purpose;
    context.params.isolatedCompletion = purpose ? true : undefined;

    await expect(
      wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context),
    ).resolves.toMatchObject({
      text: "ok",
    });
    expect(context.params.trigger).toBe("user");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  },
);
