import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import type * as harness from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi, type Mock } from "vitest";
import { copilotAttemptOverrides } from "./attempt-selectors.test-support.js";
import * as copilot from "./attempt.test-support.js";
import type { createCopilotToolBridge } from "./tool-bridge.js";

type Params = harness.AgentHarnessAttemptParamsV2;

export function registerCopilotWorkspaceTests({
  makeParams,
  makeSandboxStub,
  createStubToolBridge,
  requireCreateSessionConfig,
  workspaceBootstrapMock,
}: {
  makeParams: (overrides: Partial<Params>) => Params;
  makeSandboxStub: (overrides?: Partial<harness.SandboxContext>) => harness.SandboxContext;
  createStubToolBridge: () => Awaited<ReturnType<typeof createCopilotToolBridge>>;
  requireCreateSessionConfig: (sdk: copilot.FakeSdk) => Record<string, unknown>;
  workspaceBootstrapMock: { loadCopilotWorkspaceInstructions: Mock };
}) {
  it.each(["unsandboxed", "rw", "ro"] as const)("routes the %s workspace", async (mode) => {
    const readOnly = mode === "ro";
    const sandboxDir = `${tmpdir()}/copilot-sandbox-${Date.now()}`;
    const workspaceDir = readOnly ? `${tmpdir()}/copilot-orig-${Date.now()}` : "C:\\workspace";
    const cwd = mode === "unsandboxed" ? "C:\\workspace\\task-repo" : undefined;
    const sandboxWorkspace = readOnly ? { workspaceDir: sandboxDir } : {};
    const sandbox =
      mode === "unsandboxed"
        ? null
        : makeSandboxStub({ workspaceAccess: mode, ...sandboxWorkspace });
    const sdk = copilot.makeFakeSdk();
    const prepareRetry = vi.fn();
    const params = makeParams({ workspaceDir, ...(cwd ? { cwd } : {}) });
    const host = params.hostCapabilities;
    params.hostCapabilities = { ...host, prepareContinuationRetryCount: prepareRetry };
    const createBridge = vi.fn<typeof createCopilotToolBridge>(async () => createStubToolBridge());
    try {
      copilotAttemptOverrides.createToolBridge = createBridge;
      copilotAttemptOverrides.resolveSandboxContext = async () => sandbox;
      await copilot.runCopilotAttempt(params, { pool: copilot.makeFakePool(sdk) });
      const bridgeArgs = expectDefined(createBridge.mock.calls[0]?.[0], "bridge input");
      const effectiveWorkspaceDir = readOnly ? sandboxDir : workspaceDir;
      expect(bridgeArgs.workspaceDir).toBe(effectiveWorkspaceDir);
      const config = requireCreateSessionConfig(sdk);
      expect(config.workingDirectory).toBe(cwd ?? effectiveWorkspaceDir);
      if (mode === "unsandboxed") {
        expect(config.instructionDirectories).toEqual([workspaceDir]);
        expect(prepareRetry).toHaveBeenCalledExactlyOnceWith({ cwd: bridgeArgs.cwd });
        expect(prepareRetry.mock.invocationCallOrder[0]).toBeLessThan(
          createBridge.mock.invocationCallOrder[0]!,
        );
        expect(bridgeArgs.cwd).toBe(cwd);
      } else {
        expect(prepareRetry).not.toHaveBeenCalled();
        expect(bridgeArgs.sandbox).toBe(sandbox);
        expect(bridgeArgs.spawnWorkspaceDir).toBe(readOnly ? workspaceDir : undefined);
      }
      if (readOnly) {
        expect(workspaceBootstrapMock.loadCopilotWorkspaceInstructions.mock.lastCall).toMatchObject(
          [{ effectiveWorkspaceDir: sandboxDir, attempt: { workspaceDir } }],
        );
        await expect(fsp.stat(sandboxDir)).resolves.toBeTruthy();
      }
    } finally {
      if (readOnly) {
        await fsp.rm(sandboxDir, { recursive: true, force: true });
        await fsp.rm(workspaceDir, { recursive: true, force: true });
      }
    }
  });
}
