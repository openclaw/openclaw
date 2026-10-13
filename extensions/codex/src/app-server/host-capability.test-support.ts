import { createOpenClawCodingToolsAsync } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

type ToolsFactory = (
  ...args: Parameters<typeof createOpenClawCodingToolsAsync>
) =>
  | ReturnType<typeof createOpenClawCodingToolsAsync>
  | Awaited<ReturnType<typeof createOpenClawCodingToolsAsync>>;
type HostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];
const toolFactories = new WeakMap<object, ToolsFactory | undefined>();

export function setCodexTestToolFactory(
  params: Pick<EmbeddedRunAttemptParams, "hostCapabilities">,
  factory: ToolsFactory,
): void {
  if (!toolFactories.has(params.hostCapabilities)) {
    throw new Error(
      "Synthetic tools require a lightweight test host; keep real host identity intact.",
    );
  }
  toolFactories.set(params.hostCapabilities, factory);
  toolFactories.set(params, factory);
}

export function getCodexTestToolFactory(
  params: Pick<EmbeddedRunAttemptParams, "hostCapabilities">,
): ToolsFactory | undefined {
  return toolFactories.get(params) ?? toolFactories.get(params.hostCapabilities);
}

/** Minimal host authority for tests that do not exercise host policy or approvals. */
export function createCodexTestHostCapabilities(
  overrides: Partial<Omit<HostCapabilities, "createToolSurfaceAsync">> = {},
): HostCapabilities {
  const host: HostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    retainSourceAuthority: () => undefined,
    bindModelExecution: () => ({
      signal: new AbortController().signal,
      assertCurrent: () => host.assertActive(),
      release: () => {},
    }),
    bindToolSurface: (tools) => tools,
    createToolSurfaceAsync: async (options, bindingOptions) =>
      host.bindToolSurface(
        await (toolFactories.get(host) ?? createOpenClawCodingToolsAsync)(options),
        bindingOptions,
      ),
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
    ...overrides,
  });
  toolFactories.set(host, undefined);
  return host;
}
