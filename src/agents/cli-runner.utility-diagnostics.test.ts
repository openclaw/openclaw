import { afterEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./cli-runner/execute.test-support.js";
import { cliBackendLog } from "./cli-runner/log.js";

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.restoreAllMocks();
});

it.each([undefined, "session-activity-summary", "conversation-label"] as const)(
  "logs purpose %s at the CLI execution boundary without changing the run trigger",
  async (purpose) => {
    const log = vi.spyOn(cliBackendLog, "info").mockImplementation(() => {});
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`trigger=${purpose ?? "user"}`));
    expect(context.params.trigger).toBe("user");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  },
);
