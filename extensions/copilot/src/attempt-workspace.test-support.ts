import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  AgentHarnessAttemptParamsV2,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi, type Mock } from "vitest";
import {
  makeFakePool,
  makeFakeSdk,
  runCopilotAttempt,
  type FakeSdk,
} from "./attempt.test-support.js";
import type { createCopilotToolBridge } from "./tool-bridge.js";

type CopilotToolBridgeInput = Parameters<typeof createCopilotToolBridge>[0];

export function registerCopilotWorkspaceTests({
  makeParams,
  makeSandboxStub,
  createStubToolBridge,
  requireCreateSessionConfig,
  workspaceBootstrapMock,
}: {
  makeParams: (overrides: Partial<AgentHarnessAttemptParamsV2>) => AgentHarnessAttemptParamsV2;
  makeSandboxStub: (overrides?: Partial<SandboxContext>) => SandboxContext;
  createStubToolBridge: () => Awaited<ReturnType<typeof createCopilotToolBridge>>;
  requireCreateSessionConfig: (sdk: FakeSdk) => Record<string, unknown>;
  workspaceBootstrapMock: { loadCopilotWorkspaceInstructions: Mock };
}) {
  it.each(["unsandboxed", "rw", "ro"] as const)(
    "uses the correct SDK and tool workspace in %s mode",
    async (mode) => {
      const sandboxDir = `${tmpdir()}/copilot-sandbox-${Date.now()}`;
      const workspaceDir =
        mode === "ro" ? `${tmpdir()}/copilot-orig-${Date.now()}` : "C:\\workspace";
      const cwd = mode === "unsandboxed" ? "C:\\workspace\\task-repo" : undefined;
      const sandbox =
        mode === "unsandboxed"
          ? null
          : makeSandboxStub({
              workspaceAccess: mode,
              ...(mode === "ro" ? { workspaceDir: sandboxDir } : {}),
            });
      const sdk = makeFakeSdk();
      const prepareContinuationRetryCount = vi.fn();
      const params = makeParams({ workspaceDir, ...(cwd ? { cwd } : {}) });
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareContinuationRetryCount,
      };
      const createToolBridge = vi.fn(async (_input: CopilotToolBridgeInput) =>
        createStubToolBridge(),
      );
      try {
        await runCopilotAttempt(params, {
          createToolBridge,
          pool: makeFakePool(sdk),
          resolveSandboxContextOverride: async () => sandbox,
        });
        const bridgeArgs = expectDefined(createToolBridge.mock.calls[0]?.[0], "bridge input");
        const effectiveWorkspaceDir = mode === "ro" ? sandboxDir : workspaceDir;
        if (mode === "unsandboxed") {
          expect(prepareContinuationRetryCount).toHaveBeenCalledExactlyOnceWith({
            cwd: bridgeArgs.cwd,
          });
          expect(prepareContinuationRetryCount.mock.invocationCallOrder[0]).toBeLessThan(
            createToolBridge.mock.invocationCallOrder[0]!,
          );
        } else {
          expect(prepareContinuationRetryCount).not.toHaveBeenCalled();
        }
        expect(bridgeArgs.workspaceDir).toBe(effectiveWorkspaceDir);
        expect(requireCreateSessionConfig(sdk).workingDirectory).toBe(cwd ?? effectiveWorkspaceDir);
        if (mode === "unsandboxed") {
          expect(bridgeArgs.cwd).toBe(cwd);
          expect(requireCreateSessionConfig(sdk).instructionDirectories).toEqual([workspaceDir]);
        } else {
          expect(bridgeArgs.sandbox).toBe(sandbox);
          expect(bridgeArgs.spawnWorkspaceDir).toBe(mode === "ro" ? workspaceDir : undefined);
          if (mode === "ro") {
            expect(
              workspaceBootstrapMock.loadCopilotWorkspaceInstructions,
            ).toHaveBeenLastCalledWith(
              expect.objectContaining({
                effectiveWorkspaceDir: sandboxDir,
                attempt: expect.objectContaining({ workspaceDir }),
              }),
            );
            await expect(fsp.stat(sandboxDir)).resolves.toBeTruthy();
          }
        }
      } finally {
        if (mode === "ro") {
          await fsp.rm(sandboxDir, { recursive: true, force: true });
          await fsp.rm(workspaceDir, { recursive: true, force: true });
        }
      }
    },
  );
}
