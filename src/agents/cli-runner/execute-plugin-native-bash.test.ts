import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeExecutable,
  makeExecApprovalsTempDir,
} from "../../infra/exec-approvals-test-helpers.js";
import { loadExecApprovals, saveExecApprovals } from "../../infra/exec-approvals.js";
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

  it.each([
    ["allowlisted", "gog", "allow"],
    ["unlisted", "unlisted-tool", "deny"],
  ] as const)(
    "decides an %s native Bash command too long for a complete approval prompt",
    async (_label, executable, behavior) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const dir = makeExecApprovalsTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const binary = makeExecutable(dir, "gog");
      saveExecApprovals({ version: 1, agents: { main: { allowlist: [{ pattern: binary }] } } });
      const { context } = await createExecution({
        config: { tools: { exec: { security: "allowlist", ask: "on-miss", pathPrepend: [dir] } } },
        nativeTools: ["Bash"],
      });
      // Longer than any approval description can show in full, so only the
      // allowlist can admit it; no human may be asked to approve it.
      const command = `${executable} calendar list --query ${"a".repeat(500)}`;
      let decision: CliBackendToolPermissionResult | undefined;
      await runPlugin(context, async function* (execution) {
        decision = await execution.requestToolPermission({
          toolName: "Bash",
          toolInput: { command },
          cwd: dir,
        });
        yield SUCCESS_RESULT;
      });
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      expect(decision).toMatchObject(
        behavior === "allow"
          ? { behavior, updatedInput: { command: expect.stringContaining(binary) } }
          : { behavior, message: expect.stringContaining("too long to show in full") },
      );
    },
  );
});
