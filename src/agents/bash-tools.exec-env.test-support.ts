import { vi } from "vitest";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

export function environmentSandbox(overrides: Partial<BashSandboxConfig>): BashSandboxConfig {
  return {
    containerName: "remote-sandbox-workdir-test",
    workspaceDir: process.cwd(),
    containerWorkdir: "/remote/workspace",
    ...overrides,
  };
}

export const sandboxExecSpec = (command: string) => ({
  argv: ["remote-shell", command],
  env: {},
  stdinMode: "pipe-open" as const,
});

export type CapturedEnvironment = Pick<ExecuteNodeHostCommandParams, "env" | "requestedEnv">;
export type CapturedNodeEnvironment = CapturedEnvironment & { workdir?: string };
type Captures = {
  gatewayParams: CapturedEnvironment[];
  nodeHostParams: CapturedNodeEnvironment[];
  spawnInputs: Array<{ env?: Record<string, string> }>;
};
const copyEnvironment = ({ env, requestedEnv }: CapturedEnvironment) => ({
  env: { ...env },
  requestedEnv: requestedEnv ? { ...requestedEnv } : undefined,
});

export const shellEnvironmentMock = () => ({
  getShellEnvAppliedKeys: vi.fn(() => []),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
});

export const gatewayEnvironmentMock = (captures: Captures) => ({
  processGatewayAllowlist: vi.fn(async (params: CapturedEnvironment) => {
    captures.gatewayParams.push(copyEnvironment(params));
    return {};
  }),
});

export const nodeEnvironmentMock = (captures: Captures) => ({
  executeNodeHostCommand: vi.fn(async (params: CapturedNodeEnvironment) => {
    captures.nodeHostParams.push({ ...copyEnvironment(params), workdir: params.workdir });
    return {
      content: [{ type: "text", text: "node ok" }],
      details: { status: "completed", exitCode: 0, durationMs: 0, aggregated: "node ok" },
    };
  }),
});

export const supervisorEnvironmentMock = (captures: Captures) => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) => {
      captures.spawnInputs.push({ env: input.env ? { ...input.env } : undefined });
      input.onStdout?.("ok\n");
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => createRunExit({ durationMs: 0 }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
});
