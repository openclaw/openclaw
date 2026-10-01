import type { resolveSandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isCodexRemoteExecPlacementSandbox } from "./config.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;
type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Keeps node filesystem and process ownership on its native exec-server. */
export function resolveCodexToolConstructionPlan(
  sandbox: OpenClawSandboxContext | undefined,
  nativeToolSurfaceEnabled: boolean | undefined,
  requireWorkspaceOnly: boolean | undefined,
): OpenClawCodingToolsOptions["toolConstructionPlan"] {
  if (
    !isCodexRemoteExecPlacementSandbox(sandbox) ||
    sandbox?.backendId !== "node" ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string" ||
    !sandbox.placementNodeId
  ) {
    return requireWorkspaceOnly
      ? {
          includeBaseCodingTools: true,
          includeChannelTools: true,
          includeOpenClawTools: true,
          includePluginTools: true,
          includeShellTools: false,
        }
      : undefined;
  }
  if (!nativeToolSurfaceEnabled) {
    throw new Error(
      "Codex node execution requires its native exec-server tool surface; adjust the session tool policy and start a fresh attempt.",
    );
  }
  return {
    includeBaseCodingTools: false,
    includeShellTools: false,
    includeChannelTools: true,
    includeOpenClawTools: true,
    includePluginTools: true,
  };
}
