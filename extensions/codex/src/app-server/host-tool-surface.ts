import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type HostCapabilities = NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
type CreateToolSurface = NonNullable<HostCapabilities["createToolSurface"]>;

// Codex preserves each result's terminate marker and releases only on success.
const CODEX_TOOL_RESULT_CAPABILITIES = Object.freeze({
  terminalCompletion: "per-result" as const,
});

export function createCodexHostToolSurface(params: {
  bindingOptions?: Parameters<CreateToolSurface>[1];
  hostCapabilities: HostCapabilities;
  options: Parameters<CreateToolSurface>[0];
}): AnyAgentTool[] {
  const createToolSurface = params.hostCapabilities.createToolSurface;
  if (!createToolSurface) {
    throw new Error("Codex tool construction requires a current host capability");
  }
  return createToolSurface(params.options, params.bindingOptions, CODEX_TOOL_RESULT_CAPABILITIES);
}
