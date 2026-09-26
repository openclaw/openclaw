import type { ThinkLevel } from "../../auto-reply/thinking.js";
import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import type { CliBackendConfig, CliBackendPromptContext } from "../../plugins/cli-backend.types.js";
import { buildRuntimeContextCustomMessage } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { resolveSessionGitCoauthorPrompt } from "../git-coauthor-prompt.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import { buildProactiveSubagentOrchestrationSection } from "../ultra-orchestration.js";

/** Current-turn facts stay outside native prompts that are retained across CLI turns. */
export async function buildCliTurnAppendContext(
  params: Parameters<typeof buildMediaTaskRuntimeContext>[0] & {
    backend: CliBackendConfig;
    isNewSession: boolean;
    systemPrompt: string;
    context: readonly (string | undefined)[];
    thinkLevel?: ThinkLevel;
  },
): Promise<string> {
  const { resolveSystemPromptUsage } = await import("./helpers.js");
  const mediaTaskContext = await buildMediaTaskRuntimeContext({
    capabilityToolNames: params.capabilityToolNames,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  await prepareActiveNodeContext();
  return [
    ...params.context,
    buildProactiveSubagentOrchestrationSection({
      enabled: params.thinkLevel === "ultra",
      hasSessionsSpawn: params.capabilityToolNames.has("sessions_spawn"),
    }).join("\n"),
    buildRuntimeContextCustomMessage(mediaTaskContext)?.content,
    // Native-prompt owners and first-only resumes do not receive the current runtime line.
    resolveSystemPromptUsage(params) ? undefined : buildActiveNodeContextText(),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

/** Logical input for raw transports, policy hooks, and bounded diagnostics. */
export function composeCliPromptContext(prompt: string, context?: CliBackendPromptContext): string {
  const prepended = context?.prependContext ? `${context.prependContext}\n\n${prompt}` : prompt;
  return context?.appendContext ? `${prepended}\n\n${context.appendContext}` : prepended;
}

export async function prepareCliSystemPrompt(
  params: Omit<
    Parameters<typeof import("./helpers.js").buildCliAgentSystemPrompt>[0],
    "preparedModelRuntime" | "preparedGitCoauthorPrompt"
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
  await prepareActiveNodeContext();
  const preparedGitCoauthorPrompt = await resolveSessionGitCoauthorPrompt({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  });
  return buildCliAgentSystemPrompt({ ...params, preparedModelRuntime, preparedGitCoauthorPrompt });
}
