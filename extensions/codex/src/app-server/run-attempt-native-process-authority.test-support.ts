import path from "node:path";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { vi } from "vitest";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";

export function createSourceBoundHostCapabilities(
  signal: AbortSignal,
  requestCustody = Object.freeze({}),
) {
  const bindModelExecution = () => ({
    signal,
    assertCurrent: () => signal.throwIfAborted(),
    release: () => {},
  });
  return createCodexTestHostCapabilities({
    captureRequestCustody: () => requestCustody,
    bindModelExecution,
    retainSourceAuthority: () => ({
      ...bindModelExecution(),
      modelPolicyRequired: false,
      bindModelExecution,
    }),
  });
}

export function createSandboxPolicyRun() {
  const params = createParams(
    path.join(tempDir, "managed-policy.jsonl"),
    path.join(tempDir, "workspace"),
  );
  setRuntimeConfigSnapshot(params.config ?? {});
  const controller = new AbortController();
  const preparation: string[] = [];
  const exec = createRuntimeDynamicTool("exec");
  params.hostCapabilities = createSourceBoundHostCapabilities(controller.signal);
  params.sandbox = {
    ...createSandboxContext({}),
    sessionKey: params.sessionKey!,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    runtimeId: `managed-policy-${path.basename(tempDir)}`,
  };
  params.abortSignal = controller.signal;
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const selectTools = vi.fn(() => {
    preparation.push("tools");
    return [exec];
  });
  setCodexTestToolFactory(params, selectTools);
  return { params, controller, exec, preparation, selectTools };
}
