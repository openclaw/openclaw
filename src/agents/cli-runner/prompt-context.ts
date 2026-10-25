import {
  ensureSystemPromptCacheBoundary,
  splitSystemPromptRelocatableBoundary,
} from "@openclaw/ai/internal/shared";
import { buildHarnessVisibleReplyGuidance } from "../../auto-reply/source-reply-delivery-mode.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import { labelRuntimeContextText } from "../../llm/types.js";
import type { CliBackendConfig, CliBackendPromptContext } from "../../plugins/cli-backend.types.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";
import { buildCliSessionDriftNote } from "../cli-session-drift.js";
import { buildTemporalContextText } from "../date-time.js";
import type { ResolvedPromptBuildHookResult } from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../embedded-agent-runner/run/attempt-thread-helpers.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
} from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { resolveSessionGitCoauthorPrompt } from "../git-coauthor-prompt.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import { buildInterruptedInputContext } from "../interrupted-input-context.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { appendModelIdentitySystemPrompt, buildModelIdentityPromptLine } from "../system-prompt.js";
import { buildProactiveSubagentOrchestrationSection } from "../ultra-orchestration.js";
import { cliBackendLog } from "./log.js";
import type { CliReusableSession, RunCliAgentParams } from "./types.js";

export function finalizeCliSystemPrompt(
  systemPrompt: string,
  model: string,
  replacements: Parameters<typeof applyPluginTextReplacements>[1],
): string {
  const replaced = applyPluginTextReplacements(systemPrompt, replacements);
  // Identity belongs after the cache boundary even for marker-free hook overrides.
  // Otherwise idle and active turns would place it on different sides of the prefix.
  return appendModelIdentitySystemPrompt({
    systemPrompt:
      buildModelIdentityPromptLine(model) && replaced.trim().length > 0
        ? ensureSystemPromptCacheBoundary(replaced)
        : replaced,
    model,
  });
}

export function buildCliVisibleReplyGuidance(
  params: Pick<
    RunCliAgentParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "currentChannelId"
    | "sourceReplyDeliveryMode"
  >,
  options: Pick<
    Parameters<typeof buildHarnessVisibleReplyGuidance>[0],
    "messageToolAvailable" | "requireExplicitMessageTarget"
  >,
): string {
  return buildHarnessVisibleReplyGuidance({
    ...options,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    currentConversation: {
      agentSessionKey: params.sessionKey,
      currentChannelProvider: params.messageChannel ?? params.messageProvider,
      currentChannelId: params.currentChannelId,
    },
  });
}

export async function prepareCliTurnPromptContext(
  params: Parameters<typeof buildMediaTaskRuntimeContext>[0] & {
    backend: CliBackendConfig;
    isNewSession: boolean;
    systemPrompt: string;
    context: readonly (string | undefined)[];
    runtimeContextFragments?: RunCliAgentParams["runtimeContextFragments"];
    sessionTarget?: RunCliAgentParams["sessionTarget"];
    thinkLevel?: ThinkLevel;
    requesterProfileId?: string;
    configuredTimezone?: string;
    prompt: string;
    privateContext: boolean;
    backendId: string;
    runtimeFactsInTurn?: boolean;
    deliveryGuidance?: string;
    prependContext: readonly (string | undefined)[];
    hookResult?: ResolvedPromptBuildHookResult;
  },
): Promise<{
  prompt: string;
  systemPrompt: string;
  promptContext?: CliBackendPromptContext;
  promptForHooks?: string;
}> {
  // The local Claude plugin delivers current facts privately, outside its reusable system prompt.
  const runtimeFacts =
    params.runtimeFactsInTurn ||
    (params.backendId === "claude-cli" &&
      params.privateContext &&
      !params.hookResult?.systemPrompt?.trim())
      ? splitSystemPromptRelocatableBoundary(params.systemPrompt)
      : undefined;
  let systemPrompt = runtimeFacts?.remainingPrompt ?? params.systemPrompt;
  let prependContext = "";
  // Optional context failures must not erase Runtime facts or delivery instructions.
  let appendContext = [runtimeFacts?.relocatable, params.deliveryGuidance]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  try {
    const preparedPrependContext = params.prependContext
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n");
    const { resolveSystemPromptUsage } = await import("./helpers.js");
    const mediaTaskContext = await buildMediaTaskRuntimeContext({
      capabilityToolNames: params.capabilityToolNames,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      includeEmptySnapshots: true,
    });
    const mediaTaskMessage = buildRuntimeContextCustomMessage(mediaTaskContext);
    const interruptedInputContext = await buildInterruptedInputContext({
      sessionTarget: params.sessionTarget,
      capabilityToolNames: params.capabilityToolNames,
      includeEmptySnapshots: true,
    });
    await prepareActiveNodeContext(params.requesterProfileId);
    const preparedAppendContext = [
      runtimeFacts?.relocatable,
      ...params.context,
      params.deliveryGuidance,
      params.runtimeContextFragments?.length
        ? labelRuntimeContextText(projectRuntimeContextFragments(params.runtimeContextFragments))
        : undefined,
      buildProactiveSubagentOrchestrationSection({
        enabled: params.thinkLevel === "ultra",
        hasSessionsSpawn: params.capabilityToolNames.has("sessions_spawn"),
      }).join("\n"),
      interruptedInputContext
        ? labelRuntimeContextText(projectRuntimeContextFragments([interruptedInputContext]))
        : undefined,
      labelRuntimeContextText(
        buildTemporalContextText({
          configuredTimezone: params.configuredTimezone,
          sessionStatusAvailable: params.capabilityToolNames.has("session_status"),
        }),
      ),
      mediaTaskMessage ? labelRuntimeContextText(mediaTaskMessage.content) : undefined,
      // Native-prompt owners and first-only resumes do not receive the current runtime line.
      resolveSystemPromptUsage({ ...params, systemPrompt })
        ? undefined
        : buildActiveNodeContextText(params.requesterProfileId),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n");
    prependContext = preparedPrependContext;
    appendContext = preparedAppendContext;
    const hookSystemPrompt = params.hookResult?.systemPrompt?.trim();
    if (hookSystemPrompt) {
      systemPrompt = hookSystemPrompt;
    }
    systemPrompt =
      composeSystemPromptWithHookContext({
        baseSystemPrompt: systemPrompt,
        prependSystemContext: params.hookResult?.prependSystemContext,
        appendSystemContext: params.hookResult?.appendSystemContext,
      }) ?? systemPrompt;
  } catch (error) {
    cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
  }
  const logicalPrompt = composeCliPromptContext(params.prompt, { prependContext, appendContext });
  if ((prependContext || appendContext) && params.privateContext) {
    // The plugin transports private context separately; policy hooks still see all of it.
    return {
      prompt: params.prompt,
      systemPrompt,
      promptContext: {
        ...(prependContext ? { prependContext } : {}),
        ...(appendContext ? { appendContext } : {}),
      },
      promptForHooks: logicalPrompt,
    };
  }
  return { prompt: logicalPrompt, systemPrompt };
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
  await prepareActiveNodeContext(params.requesterProfileId);
  const preparedGitCoauthorPrompt = await resolveSessionGitCoauthorPrompt({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  });
  const preparedTtsPreferences = params.preparedTtsPreferences ?? (await prepareTtsPreferences());
  return buildCliAgentSystemPrompt({
    ...params,
    preparedModelRuntime,
    preparedGitCoauthorPrompt,
    preparedTtsPreferences,
  });
}

export function createCliCurrentPromptRenderer(
  params: Pick<RunCliAgentParams, "currentInboundContext" | "inputProvenance">,
  reusableCliSession: CliReusableSession,
  notes: {
    sessionGapContext?: string;
  } = {},
) {
  let context = params.currentInboundContext;
  const note =
    reusableCliSession.mode === "reuse-with-drift"
      ? buildCliSessionDriftNote(reusableCliSession.drift.reasons)
      : undefined;
  if (note) {
    context = context
      ? {
          ...context,
          text: [note, context.text].join("\n\n"),
          ...(context.resumableText
            ? { resumableText: [note, context.resumableText].join("\n\n") }
            : {}),
        }
      : { text: note };
  }
  return (prompt: string, preferResumableText = false) =>
    composeCliPromptContext(
      annotateInterSessionPromptText(
        buildCurrentInboundPrompt({ context, prompt, preferResumableText }),
        params.inputProvenance,
      ),
      { prependContext: notes.sessionGapContext },
    );
}
