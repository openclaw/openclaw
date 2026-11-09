import { afterEach, expect, it, vi } from "vitest";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import {
  closePluginTestAdmissions,
  createExecution,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

afterEach(closePluginTestAdmissions);

it.each([false, true])("checks private input at plugin dispatch (revoked=%s)", async (revoked) => {
  const { context } = await createExecution();
  context.preparedBackend.backend.command = process.execPath;
  let authorized = !revoked;
  context.params.assertPrivateInputCurrent = () => {
    if (!authorized) {
      throw new Error("Private input authorization changed");
    }
  };
  const execute = vi.fn<CliBackendExecute>(async function* () {
    // Revocation after dispatch must not fail later settlement of completed work.
    authorized = false;
    yield SUCCESS_RESULT;
  });
  const run = executePluginOwnedProcess({
    context,
    execute,
    executionCommand: process.execPath,
    executionArgs: [],
    env: {},
    prompt: context.params.prompt,
    useResume: false,
    noOutputTimeoutMs: 5_000,
    consumeStdout: () => {},
  });
  if (revoked) {
    await expect(run).rejects.toThrow("Private input authorization changed");
    expect(execute).not.toHaveBeenCalled();
  } else {
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(execute).toHaveBeenCalledOnce();
  }
});
