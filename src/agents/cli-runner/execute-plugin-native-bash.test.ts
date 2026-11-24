import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
});

describe("native Bash execution policy", () => {
  it("rejects native Bash when OpenClaw owns shell execution", async () => {
    // Worker startup must not expire a policy fixture before the native request.
    vi.useFakeTimers({ toFake: ["Date"] });
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    context.hostOwnedTools = ["exec", "process"];
    let decision: CliBackendToolPermissionResult | undefined;
    const runExit = await runPlugin(context, async function* (execution) {
      decision = await execution.requestToolPermission({
        toolName: "Bash",
        toolInput: { command: "echo must-use-managed-exec" },
      });
      yield SUCCESS_RESULT;
    });
    expect(decision).toEqual({
      behavior: "deny",
      message: "Use OpenClaw exec; its native equivalent is unavailable.",
    });
    expect(runExit).toMatchObject({ reason: "exit", exitCode: 0 });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
