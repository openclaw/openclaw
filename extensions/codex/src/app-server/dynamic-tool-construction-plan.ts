import type {
  EmbeddedRunAttemptParamsV2,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithCronCreatorAuthorityCapabilityResolver } from "openclaw/plugin-sdk/codex-mcp-projection";
import { isCodexPairedNodeRemoteExecPlacementSandbox } from "./config.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<
    (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingToolsAsync"]
  >[0]
>;
type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Constructs through the live host while preserving the originating cron authority scope. */
export function createCodexHostToolSurface(
  params: Pick<
    EmbeddedRunAttemptParamsV2,
    "hostCapabilities" | "cronCreatorAuthorityCapability" | "runId"
  >,
  options: OpenClawCodingToolsOptions,
  bindingOptions: Readonly<{ cwd: string }>,
  resolveCronCreatorToolAuthority?: Parameters<
    typeof runWithCronCreatorAuthorityCapabilityResolver
  >[0]["resolve"],
) {
  const construct = () => {
    const createToolSurfaceAsync = params.hostCapabilities.createToolSurfaceAsync;
    if (!createToolSurfaceAsync) {
      throw new Error("Codex tool construction requires a current host capability");
    }
    return createToolSurfaceAsync(options, bindingOptions);
  };
  return resolveCronCreatorToolAuthority
    ? runWithCronCreatorAuthorityCapabilityResolver({
        capability: params.cronCreatorAuthorityCapability,
        runId: params.runId,
        resolve: resolveCronCreatorToolAuthority,
        run: construct,
      })
    : construct();
}

/** Keeps node filesystem and process ownership on its native exec-server. */
export function resolveCodexToolConstructionPlan(
  sandbox: OpenClawSandboxContext | undefined,
  nativeToolSurfaceEnabled: boolean | undefined,
  requireWorkspaceOnly: boolean | undefined,
): OpenClawCodingToolsOptions["toolConstructionPlan"] {
  const nodeExecution =
    isCodexPairedNodeRemoteExecPlacementSandbox(sandbox) && sandbox?.backendId === "node";
  if (!nodeExecution && !requireWorkspaceOnly) {
    return undefined;
  }
  if (nodeExecution && !nativeToolSurfaceEnabled) {
    throw new Error(
      "Codex node execution requires its native exec-server tool surface; adjust the session tool policy and start a fresh attempt.",
    );
  }
  return {
    includeBaseCodingTools: !nodeExecution,
    includeShellTools: false,
    includeChannelTools: true,
    includeOpenClawTools: true,
    includePluginTools: true,
  };
}
