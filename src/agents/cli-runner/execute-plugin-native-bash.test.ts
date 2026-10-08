import { afterEach, describe, expect, it, vi } from "vitest";
import { saveExecApprovals } from "../../infra/exec-approvals-store.test-support.js";
import {
  makeExecutable,
  makeExecApprovalsTempDir,
} from "../../infra/exec-approvals-test-helpers.js";
import { loadExecApprovals } from "../../infra/exec-approvals.js";
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

  it.each([
    ["allowlist", "on-miss", "allow"],
    ["deny", "on-miss", "deny"],
    ["allowlist", "off", "deny"],
  ] as const)(
    "applies %s/%s to native Bash with configured PATH",
    async (security, ask, behavior) => {
      // This matrix checks policy, not elapsed time. Keep filesystem I/O real
      // while the run clock stays fixed; watchdog expiry has separate coverage.
      vi.useFakeTimers({ toFake: ["Date"] });
      const dir = makeExecApprovalsTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const binary = makeExecutable(dir, "gog");
      saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
      const { context } = await createExecution({
        config: { tools: { exec: { security, ask, pathPrepend: [dir] } } },
        nativeTools: ["Bash"],
      });
      let decision: CliBackendToolPermissionResult | undefined;
      const runExit = await runPlugin(context, async function* (execution) {
        decision = await execution.requestToolPermission({
          toolName: "Bash",
          toolInput: { command: "gog calendar list" },
          cwd: dir,
        });
        yield SUCCESS_RESULT;
      });
      expect(decision?.behavior, JSON.stringify({ decision, runExit })).toBe(behavior);
      expect(runExit).toMatchObject({ reason: "exit", exitCode: 0, timedOut: false });
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      if (decision?.behavior === "allow") {
        expect(decision.updatedInput?.command).toContain(binary);
        expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toEqual(
          expect.any(Number),
        );
      } else {
        expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
      }
    },
  );

  it("uses the runtime policy agent for native Bash allowlist grants", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = makeExecApprovalsTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const binary = makeExecutable(dir, "gog");
    saveExecApprovals({
      version: 1,
      agents: {
        main: { allowlist: [{ pattern: binary }] },
        worker: { allowlist: [] },
      },
    });
    mockCallGatewayTool.mockResolvedValueOnce({ id: "worker-miss", decision: "deny" });
    const { context } = await createExecution({
      config: {
        agents: {
          entries: {
            main: { tools: { profile: "full" } },
            worker: { tools: { profile: "full" } },
          },
        },
        tools: { exec: { security: "allowlist", ask: "on-miss", pathPrepend: [dir] } },
      },
      nativeTools: ["Bash"],
    });
    context.params.runtimePolicySessionKey = "agent:worker:main";

    let decision: CliBackendToolPermissionResult | undefined;
    await runPlugin(context, async function* (execution) {
      decision = await execution.requestToolPermission({
        toolName: "Bash",
        toolInput: { command: `${binary} calendar list` },
        cwd: dir,
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      agentId: "worker",
      sessionKey: "agent:main:main",
    });
    expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedAt).toBeUndefined();
  });
});
