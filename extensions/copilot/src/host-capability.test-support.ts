import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

type HostCapabilities = AgentHarnessAttemptParamsV2["hostCapabilities"];

/** Minimal host authority for tests that do not exercise host policy or approvals. */
export function createCopilotTestHostCapabilities(
  createToolSurface?: (
    ...args: Parameters<NonNullable<HostCapabilities["createToolSurfaceAsync"]>>
  ) =>
    | ReturnType<HostCapabilities["bindToolSurface"]>
    | Promise<ReturnType<HostCapabilities["bindToolSurface"]>>,
  bindToolSurface: HostCapabilities["bindToolSurface"] = (tools) => tools,
): HostCapabilities {
  const construct: HostCapabilities["createToolSurfaceAsync"] = createToolSurface
    ? async (options, binding) => bindToolSurface(await createToolSurface(options), binding)
    : undefined;
  return Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface,
    ...(construct ? { createToolSurfaceAsync: construct } : {}),
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  });
}
