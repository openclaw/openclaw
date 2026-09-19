import type { CliBackendPromptContext } from "../../plugins/cli-backend.types.js";

/** Logical input for raw transports, policy hooks, and bounded diagnostics. */
export function composeCliPromptContext(prompt: string, context?: CliBackendPromptContext): string {
  const prepended = context?.prependContext ? `${context.prependContext}\n\n${prompt}` : prompt;
  return context?.appendContext ? `${prepended}\n\n${context.appendContext}` : prepended;
}

export async function prepareCliSystemPrompt(
  params: Omit<
    Parameters<typeof import("./helpers.js").buildCliAgentSystemPrompt>[0],
    "preparedModelRuntime"
  >,
): Promise<string> {
  const { buildCliAgentSystemPrompt } = await import("./helpers.js");
  let preparedModelRuntime:
    | import("../prepared-model-runtime.types.js").PreparedModelRuntimeSnapshot
    | undefined;
  if (params.config) {
    const { getPreparedModelRuntimeBorrowedSnapshot, getPreparedModelRuntimePluginGeneration } =
      await import("../prepared-model-runtime-generation-scope.js");
    const generation = getPreparedModelRuntimePluginGeneration();
    const borrowed = generation ? getPreparedModelRuntimeBorrowedSnapshot(generation) : undefined;
    if (
      borrowed?.config === params.config &&
      borrowed.agentId === params.agentId &&
      borrowed.workspaceDir === params.workspaceDir
    ) {
      preparedModelRuntime = borrowed;
    } else {
      const { getPreparedModelCatalogOwnerSnapshot } = await import("../prepared-model-catalog.js");
      preparedModelRuntime = getPreparedModelCatalogOwnerSnapshot({
        config: params.config,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
      });
    }
  }
  return buildCliAgentSystemPrompt({ ...params, preparedModelRuntime });
}
