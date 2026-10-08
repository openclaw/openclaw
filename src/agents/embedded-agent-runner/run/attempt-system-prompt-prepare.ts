import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import {
  resolveProviderSystemPromptContribution,
  transformProviderSystemPrompt,
} from "../../../plugins/provider-runtime.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { prepareTtsPreferences } from "../../../tts/tts-preferences.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import {
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import {
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
} from "../../bootstrap-budget.js";
import { resolveOpenClawReferencePaths } from "../../docs-path.js";
import { prepareAgentMemoryPrompt } from "../../memory-prompt-prepare.js";
import { buildModelToolsUnavailablePrompt } from "../../model-tool-support.js";
import {
  buildProjectMemoryWriteInstruction,
  prepareProjectMemoryBootstrap,
} from "../../project-memory-bootstrap.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../prompt-surface.js";
import { resolveAgentRuntimePrompt } from "../../runtime-prompt.js";
import type { buildConfiguredAgentSystemPrompt } from "../../system-prompt-config.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { toolPolicyRestrictsTools } from "../../tool-policy.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { buildToolSchemaDirectoryPrompt } from "../../tool-search.js";
import { prepareWatchedSessionsPromptAsync } from "../../watched-sessions-prompt.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "../sandbox-info.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { resolvePromptModeForSession } from "./attempt-prompt-helpers.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import { buildAttemptSystemPrompt, type SystemPromptRefresh } from "./attempt-system-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedBootstrap = Awaited<ReturnType<typeof prepareEmbeddedAttemptBootstrap>>;
type PromptTools = NonNullable<Parameters<typeof buildConfiguredAgentSystemPrompt>[0]["tools"]>;

export async function prepareEmbeddedAttemptSystemPrompt(params: {
  activeContextEngine: EmbeddedRunAttemptParams["contextEngine"];
  attempt: Omit<
    EmbeddedRunAttemptParams,
    | "workspaceDir"
    | "prompt"
    | "timeoutMs"
    | "sessionFile"
    | "authStorage"
    | "authProfileStore"
    | "modelRegistry"
    | "thinkLevel"
    | "fastMode"
  >;
  setup: Pick<
    EmbeddedAttemptSetup,
    | "effectiveCwd"
    | "effectiveWorkspace"
    | "proactiveSubagentOrchestration"
    | "sandbox"
    | "sandboxReport"
    | "sandboxSessionKey"
    | "sessionAgentId"
  > & {
    prepStages?: Pick<EmbeddedAttemptSetup["prepStages"], "mark">;
    getProviderRuntimeHandle: () => import("../../../plugins/provider-hook-runtime.js").ProviderRuntimePluginHandle;
  };
  referencePaths?: Awaited<ReturnType<typeof resolveOpenClawReferencePaths>>;
  remoteWorkspace?: boolean;
  toolSchemaDirectoryPrompt?: () => string | undefined;
  bootstrap: PreparedBootstrap;
  capabilityToolNames: Set<string>;
  requireExplicitMessageTarget?: boolean;
  effectiveTools: PromptTools;
  isRawModelRun: boolean;
  modelToolsEnabled: boolean;
  skillsPrompt: string;
  codeModeActive?: boolean;
  webSearchUnconfigured?: () => boolean;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  toolSearchDirectoryEnabled: boolean;
  toolSearchRuntimeConfig: EmbeddedRunAttemptParams["config"];
}) {
  const { attempt } = params;
  if (attempt.operation === "settled-tool-finalization") {
    // Finalization resumes the settled transcript with only the host prompt.
    // Do not invoke provider/plugin contributors or assemble ambient context.
    params.setup.prepStages?.mark("system-prompt");
    return {
      runtimeChannel: undefined,
      runtimeInfo: { model: `${attempt.provider}/${attempt.modelId}` },
      systemPromptReport: undefined,
      systemPromptText: "",
    };
  }
  const policyPreparation = {
    signal: attempt.abortSignal,
    assertCurrent: resolveAdmittedRunActiveAssertion(
      attempt.admittedRunContext,
      attempt.abortSignal,
    ),
  };
  const resolveSandboxInfo = async () => {
    if (!params.setup.sandbox?.enabled) {
      return undefined;
    }
    // Keep the original lifetime check when no elevation policy is needed.
    policyPreparation.signal?.throwIfAborted();
    policyPreparation.assertCurrent?.();
    const sandboxInfoExecPolicy =
      attempt.bashElevated?.enabled === true
        ? await resolveEmbeddedSandboxInfoExecPolicy(
            {
              config: attempt.config,
              agentId: params.setup.sessionAgentId,
              sessionKey: attempt.sessionKey,
              permissionMode: attempt.permissionMode,
              sandboxAvailable: params.setup.sandbox.enabled,
              execOverrides: attempt.execOverrides,
            },
            policyPreparation,
          )
        : undefined;
    return buildEmbeddedSandboxInfo(
      params.setup.sandbox ?? undefined,
      attempt.bashElevated,
      sandboxInfoExecPolicy,
    );
  };
  const sandboxInfo = await resolveSandboxInfo();
  const reasoningTagHint = isReasoningTagProvider(attempt.provider, {
    config: attempt.config,
    workspaceDir: params.setup.effectiveWorkspace,
    env: process.env,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    model: attempt.model,
    runtimeHandle: params.setup.getProviderRuntimeHandle(),
  });
  const resolveToolSchemaDirectoryPrompt = () =>
    params.toolSchemaDirectoryPrompt?.() ??
    (params.toolSearchDirectoryEnabled && params.toolSearchCatalogRef?.current?.entries.length
      ? buildToolSchemaDirectoryPrompt(
          {
            config: attempt.config,
            runtimeConfig: params.toolSearchRuntimeConfig,
            agentId: params.setup.sessionAgentId,
            sessionKey: params.setup.sandboxSessionKey,
            sessionId: attempt.sessionId,
            runId: attempt.runId,
            catalogRef: params.toolSearchCatalogRef,
          },
          { contextTokenBudget: attempt.contextTokenBudget },
        )
      : undefined);

  const toolSchemaDirectoryPrompt = resolveToolSchemaDirectoryPrompt();

  const { runtimeChannel, runtimeCapabilities, ...runtimePrompt } = await resolveAgentRuntimePrompt(
    {
      remoteWorkspace: params.remoteWorkspace,
      config: attempt.config,
      preparedGitCoauthorPrompt: attempt.gitCoauthorPrompt,
      agentId: params.setup.sessionAgentId,
      workspaceDir: params.setup.effectiveWorkspace,
      cwd: params.setup.effectiveCwd,
      ...(attempt.preparedModelRuntime && Object.hasOwn(attempt.preparedModelRuntime, "repoRoot")
        ? { preparedRepoRoot: attempt.preparedModelRuntime.repoRoot }
        : {}),
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      model: `${attempt.provider}/${attempt.modelId}`,
      channel: attempt.messageChannel ?? attempt.messageProvider,
      accountId: attempt.agentAccountId,
      chatType: attempt.chatType,
      requesterProfileId: readAdmittedRunOperatorAuthority(attempt.admittedRunContext)?.profileId,
    },
  );
  const promptMode =
    attempt.promptMode ??
    (params.isRawModelRun ? "none" : resolvePromptModeForSession(attempt.sessionKey));
  const promptSurface = resolveAgentPromptSurfaceForSessionKey(attempt.sessionKey);
  const toolPolicyRestricted = toolPolicyRestrictsTools({ allow: attempt.toolsAllow });
  const effectivePromptMode = toolPolicyRestricted ? ("minimal" as const) : promptMode;
  const effectiveSkillsPrompt = toolPolicyRestricted ? undefined : params.skillsPrompt;
  const openClawReferences =
    params.referencePaths ??
    (await resolveOpenClawReferencePaths({
      workspaceDir: params.setup.effectiveWorkspace,
      argv1: process.argv[1],
      cwd: params.setup.effectiveCwd,
      moduleUrl: import.meta.url,
    }));
  const providerPromptContext = Object.freeze({
    config: attempt.config,
    agentDir: attempt.agentDir,
    workspaceDir: params.setup.effectiveWorkspace,
    provider: attempt.provider,
    modelId: attempt.modelId,
    promptMode: effectivePromptMode,
    runtimeChannel,
    runtimeCapabilities,
    agentId: params.setup.sessionAgentId,
  });
  const promptContributionContext = { ...providerPromptContext, trigger: attempt.trigger };
  const promptContribution =
    attempt.runtimePlan?.prompt.resolveSystemPromptContribution(promptContributionContext) ??
    resolveProviderSystemPromptContribution({
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: params.setup.effectiveWorkspace,
      runtimeHandle: params.setup.getProviderRuntimeHandle(),
      context: promptContributionContext,
    });
  const includeMemorySection =
    !params.activeContextEngine || params.activeContextEngine.info.id === "legacy";
  const prepareToolContextSections = async (
    tools: PromptTools,
    capabilityToolNames: Iterable<string>,
    sandboxed: boolean,
  ) => {
    const toolContext = {
      toolNames: tools.map((tool) => tool.name),
      capabilityToolNames,
      sandboxed,
    };
    return {
      preparedMemoryPrompt: await prepareAgentMemoryPrompt({
        ...toolContext,
        enabled: effectivePromptMode === "full" && includeMemorySection,
        citationsMode: attempt.config?.memory?.citations,
        agentId: runtimePrompt.runtimeInfo.agentId,
        agentSessionKey: runtimePrompt.runtimeInfo.sessionKey,
      }),
      preparedWatchedSessions: await prepareWatchedSessionsPromptAsync({
        ...toolContext,
        enabled: effectivePromptMode === "full",
        config: attempt.config,
        sessionKey: attempt.sessionKey,
        assertCurrent: () => {
          policyPreparation.signal?.throwIfAborted();
          policyPreparation.assertCurrent?.();
        },
      }),
    };
  };
  const { preparedMemoryPrompt, preparedWatchedSessions } = await prepareToolContextSections(
    params.effectiveTools,
    params.capabilityToolNames,
    sandboxInfo?.enabled === true,
  );
  const activeProjectKeys = attempt.preparedModelRuntime?.activeProjectKeys ?? [];
  const projectMemoryBootstrap =
    effectivePromptMode === "full" && activeProjectKeys.length > 0
      ? await prepareProjectMemoryBootstrap({
          cfg: attempt.config ?? {},
          agentId: params.setup.sessionAgentId,
          activeProjectKeys,
          context: policyPreparation.assertCurrent
            ? {
                authority: attempt.sessionKey
                  ? {
                      kind: "session",
                      sessionKey: attempt.sessionKey,
                      sessionId: attempt.sessionId,
                      sandboxed: sandboxInfo?.enabled === true,
                      audience: attempt.memoryAudience,
                    }
                  : { kind: "host", operation: "project-memory-bootstrap" },
                assertCurrent: policyPreparation.assertCurrent,
                signal: policyPreparation.signal,
              }
            : undefined,
        })
      : [];
  const projectMemoryWriteInstruction = buildProjectMemoryWriteInstruction(
    attempt.preparedModelRuntime?.projectKey,
  );
  const extraSystemPrompt = joinPresentTextSegments([
    attempt.extraSystemPrompt,
    projectMemoryWriteInstruction,
    buildModelToolsUnavailablePrompt(params.modelToolsEnabled),
  ]);

  const promptInputs: Parameters<typeof buildAttemptSystemPrompt>[0] = {
    isRawModelRun: params.isRawModelRun,
    transformSystemPrompt: (systemPrompt) =>
      transformProviderSystemPrompt({
        ...providerPromptContext,
        runtimeHandle: params.setup.getProviderRuntimeHandle(),
        context: { ...providerPromptContext, systemPrompt },
      }),
    embeddedSystemPrompt: {
      ...runtimePrompt,
      config: attempt.config,
      preparedModelRuntime: attempt.preparedModelRuntime,
      preparedTtsPreferences:
        attempt.preparedTtsPreferences ??
        (effectivePromptMode === "full" ? await prepareTtsPreferences() : undefined),
      agentId: params.setup.sessionAgentId,
      workspaceDir: params.setup.effectiveWorkspace,
      runtimeCwd: params.setup.effectiveCwd,
      reasoningLevel: attempt.reasoningLevel ?? "off",
      extraSystemPrompt,
      ownerNumbers: attempt.ownerNumbers,
      reasoningTagHint,
      skillsPrompt: effectiveSkillsPrompt,
      codeModeActive: params.codeModeActive,
      webSearchUnconfigured: params.webSearchUnconfigured?.(),
      docsPath: openClawReferences.docsPath ?? undefined,
      sourcePath: openClawReferences.sourcePath ?? undefined,
      workspaceNotes: params.bootstrap.workspaceNotes.length
        ? params.bootstrap.workspaceNotes
        : undefined,
      promptMode: effectivePromptMode,
      sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
      requireExplicitMessageTarget: params.requireExplicitMessageTarget,
      silentReplyPromptMode: attempt.silentReplyPromptMode,
      proactiveSubagentOrchestration: params.setup.proactiveSubagentOrchestration,
      acpEnabled: isAcpRuntimeSpawnAvailable({
        config: attempt.config,
        sandboxed: sandboxInfo?.enabled === true,
      }),
      promptSurface,
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: promptSurface,
      }),
      toolSchemaDirectoryPrompt,
      sandboxInfo,
      capabilityToolNames: [...params.capabilityToolNames].toSorted(),
      tools: params.effectiveTools,
      contextFiles: params.bootstrap.contextFiles,
      bootstrapMode: params.bootstrap.bootstrapMode,
      bootstrapTruncationNotice: buildBootstrapPromptWarningNotice(
        params.bootstrap.bootstrapPromptWarning.lines,
      ),
      includeMemorySection,
      preparedMemoryPrompt,
      preparedWatchedSessions,
      projectMemoryBootstrap,
      activeProjectKeys,
      promptContribution,
    },
  };
  const attemptSystemPrompt = await buildAttemptSystemPrompt(promptInputs);
  policyPreparation.signal?.throwIfAborted();
  policyPreparation.assertCurrent?.();
  const reportInputs: Parameters<typeof buildSystemPromptReport>[0] = {
    source: "run",
    generatedAt: Date.now(),
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    provider: attempt.provider,
    model: attempt.modelId,
    workspaceDir: params.setup.effectiveWorkspace,
    bootstrapMaxChars: params.bootstrap.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrap.bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: params.bootstrap.bootstrapAnalysis,
      warningMode: params.bootstrap.bootstrapPromptWarningMode,
      warning: params.bootstrap.bootstrapPromptWarning,
    }),
    sandbox: params.setup.sandboxReport,
    systemPrompt: attemptSystemPrompt.systemPrompt,
    injectedWorkspaceFiles: params.bootstrap.bootstrapInjectionStats,
    skillsPrompt: attemptSystemPrompt.skillsPrompt,
    tools: params.effectiveTools,
  };
  const systemPromptReport = buildSystemPromptReport(reportInputs);
  params.setup.prepStages?.mark("system-prompt");

  const readToolPromptInputs = (tools: PromptTools, permissionChanged = false) => ({
    mode: attempt.permissionMode,
    tools,
    capabilities: [...params.capabilityToolNames].toSorted(),
    catalogEntries: params.toolSearchCatalogRef?.current?.entries,
    permissionChanged,
  });
  let toolPromptPreparation = {
    ...readToolPromptInputs([...params.effectiveTools]),
    promise: Promise.resolve<SystemPromptRefresh>((currentSystemPrompt) => currentSystemPrompt),
  };

  return {
    runtimeChannel,
    runtimeInfo: runtimePrompt.runtimeInfo,
    systemPromptReport,
    systemPromptText: attemptSystemPrompt.systemPrompt,
    prepareToolPrompt: (
      effectiveTools: PromptTools = params.effectiveTools,
      { permissionChanged = false }: { permissionChanged?: boolean } = {},
    ): Promise<SystemPromptRefresh> => {
      const inputs = readToolPromptInputs(effectiveTools, permissionChanged);
      const { mode, capabilities, catalogEntries } = inputs;
      if (
        toolPromptPreparation.mode === mode &&
        toolPromptPreparation.permissionChanged === permissionChanged &&
        toolPromptPreparation.catalogEntries === catalogEntries &&
        toolPromptPreparation.tools.length === effectiveTools.length &&
        toolPromptPreparation.tools.every((tool, index) => tool === effectiveTools[index]) &&
        toolPromptPreparation.capabilities.length === capabilities.length &&
        toolPromptPreparation.capabilities.every((name, index) => name === capabilities[index])
      ) {
        return toolPromptPreparation.promise;
      }
      // Prepare once per tool/policy generation. Memory supplements may await;
      // keep their immutable context separate until the model boundary accepts it.
      const tools = [...effectiveTools];
      const refreshedToolSchemaDirectoryPrompt = resolveToolSchemaDirectoryPrompt();
      const sandboxInfoPreparation = resolveSandboxInfo();
      const promise = (async () => {
        const refreshedSandboxInfo = await sandboxInfoPreparation;
        const embeddedSystemPrompt = {
          ...promptInputs.embeddedSystemPrompt,
          tools,
          webSearchUnconfigured: params.webSearchUnconfigured?.(),
          capabilityToolNames: capabilities,
          toolSchemaDirectoryPrompt: refreshedToolSchemaDirectoryPrompt,
          sandboxInfo: refreshedSandboxInfo,
        };
        Object.assign(
          embeddedSystemPrompt,
          await prepareToolContextSections(
            tools,
            capabilities,
            refreshedSandboxInfo?.enabled === true,
          ),
        );
        const nextSystemPrompt = await buildAttemptSystemPrompt({
          ...promptInputs,
          embeddedSystemPrompt,
        });
        const permissionNotice = permissionChanged
          ? `## Permission change\nThe operator changed workspace permissions to ${mode ?? "configured defaults"}. Continue the current task with the updated tools and permissions. Inspect interrupted actions before retrying; do not repeat completed actions.`
          : undefined;
        const refresh: SystemPromptRefresh = (currentSystemPrompt) => {
          if (params.isRawModelRun) {
            return currentSystemPrompt;
          }
          policyPreparation.signal?.throwIfAborted();
          policyPreparation.assertCurrent?.();
          const systemPrompt = nextSystemPrompt.refreshSystemPrompt(
            currentSystemPrompt,
            permissionNotice,
          );
          Object.assign(
            systemPromptReport,
            buildSystemPromptReport({
              ...reportInputs,
              generatedAt: Date.now(),
              systemPrompt,
              skillsPrompt: nextSystemPrompt.skillsPrompt,
              tools,
            }),
          );
          return systemPrompt;
        };
        refresh.freshlyRendered = !params.isRawModelRun;
        return refresh;
      })();
      toolPromptPreparation = {
        ...inputs,
        tools,
        promise,
      };
      return promise;
    },
  };
}
