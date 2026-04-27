import { createCodingTools, createReadTool } from "@mariozechner/pi-coding-agent";
import { resolveMergedSafeBinProfileFixtures } from "../infra/exec-safe-bin-runtime-policy.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../shared/string-coerce.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";
import { execSchema, processSchema } from "./bash-tools.schemas.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { shouldSuppressManagedWebSearchTool } from "./codex-native-web-search.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { applyDeferredFollowupToolDescriptions } from "./pi-tools.deferred-followup.js";
import { filterToolsByMessageProvider } from "./pi-tools.message-provider-policy.js";
import { isToolAllowedByPolicies, resolveEffectiveToolPolicy, resolveGroupToolPolicy, resolveSubagentToolPolicyForSession, } from "./pi-tools.policy.js";
import { assertRequiredParams, createHostWorkspaceEditTool, createHostWorkspaceWriteTool, createOpenClawReadTool, createSandboxedEditTool, createSandboxedReadTool, createSandboxedWriteTool, getToolParamsRecord, wrapToolMemoryFlushAppendOnlyWrite, wrapToolWorkspaceRootGuard, wrapToolWorkspaceRootGuardWithOptions, wrapToolParamValidation, } from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import { isSubagentEnvelopeSession, resolveSubagentCapabilityStore, } from "./subagent-capabilities.js";
import { EXEC_TOOL_DISPLAY_SUMMARY, PROCESS_TOOL_DISPLAY_SUMMARY, } from "./tool-description-presets.js";
import { createToolFsPolicy, resolveToolFsConfig } from "./tool-fs-policy.js";
import { applyToolPolicyPipeline, buildDefaultToolPolicyPipelineSteps, } from "./tool-policy-pipeline.js";
import { applyOwnerOnlyToolPolicy, collectExplicitAllowlist, mergeAlsoAllowPolicy, resolveToolProfilePolicy, } from "./tool-policy.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";
function isOpenAIProvider(provider) {
    const normalized = normalizeOptionalLowercaseString(provider);
    return normalized === "openai" || normalized === "openai-codex";
}
const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);
let bashToolsModulePromise;
function loadBashToolsModule() {
    bashToolsModulePromise ??= import("./bash-tools.js");
    return bashToolsModulePromise;
}
function createLazyExecTool(defaults) {
    let loadedTool;
    const loadTool = async () => {
        if (!loadedTool) {
            const { createExecTool } = await loadBashToolsModule();
            loadedTool = createExecTool(defaults);
        }
        return loadedTool;
    };
    return {
        name: "exec",
        label: "exec",
        displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
        get description() {
            return describeExecTool({
                agentId: defaults?.agentId,
                hasCronTool: defaults?.hasCronTool === true,
            });
        },
        parameters: execSchema,
        execute: async (...args) => (await loadTool()).execute(...args),
    };
}
function createLazyProcessTool(defaults) {
    let loadedTool;
    const loadTool = async () => {
        if (!loadedTool) {
            const { createProcessTool } = await loadBashToolsModule();
            loadedTool = createProcessTool(defaults);
        }
        return loadedTool;
    };
    return {
        name: "process",
        label: "process",
        displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
        description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
        parameters: processSchema,
        execute: async (...args) => (await loadTool()).execute(...args),
    };
}
function applyModelProviderToolPolicy(tools, params) {
    if (params?.config?.agents?.defaults?.experimental?.localModelLean === true) {
        const leanDeny = new Set(["browser", "cron", "message"]);
        tools = tools.filter((tool) => !leanDeny.has(tool.name));
    }
    if (shouldSuppressManagedWebSearchTool({
        config: params?.config,
        modelProvider: params?.modelProvider,
        modelApi: params?.modelApi,
        agentDir: params?.agentDir,
    })) {
        return tools.filter((tool) => tool.name !== "web_search");
    }
    return tools;
}
function isApplyPatchAllowedForModel(params) {
    const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
    if (allowModels.length === 0) {
        return true;
    }
    const modelId = params.modelId?.trim();
    if (!modelId) {
        return false;
    }
    const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
    const provider = normalizeOptionalLowercaseString(params.modelProvider);
    const normalizedFull = provider && !normalizedModelId.includes("/")
        ? `${provider}/${normalizedModelId}`
        : normalizedModelId;
    return allowModels.some((entry) => {
        const normalized = normalizeOptionalLowercaseString(entry);
        if (!normalized) {
            return false;
        }
        return normalized === normalizedModelId || normalized === normalizedFull;
    });
}
function resolveExecConfig(params) {
    const cfg = params.cfg;
    const globalExec = cfg?.tools?.exec;
    const agentExec = cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined;
    return {
        host: agentExec?.host ?? globalExec?.host,
        security: agentExec?.security ?? globalExec?.security,
        ask: agentExec?.ask ?? globalExec?.ask,
        node: agentExec?.node ?? globalExec?.node,
        pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
        safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
        strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
        safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
        safeBinProfiles: resolveMergedSafeBinProfileFixtures({
            global: globalExec,
            local: agentExec,
        }),
        backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
        timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
        approvalRunningNoticeMs: agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
        cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
        notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
        notifyOnExitEmptySuccess: agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
        applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch,
    };
}
export function resolveToolLoopDetectionConfig(params) {
    const global = params.cfg?.tools?.loopDetection;
    const agent = params.agentId && params.cfg
        ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
        : undefined;
    if (!agent) {
        return global;
    }
    if (!global) {
        return agent;
    }
    return {
        ...global,
        ...agent,
        detectors: {
            ...global.detectors,
            ...agent.detectors,
        },
    };
}
export const __testing = {
    cleanToolSchemaForGemini,
    getToolParamsRecord,
    wrapToolParamValidation,
    assertRequiredParams,
    applyModelProviderToolPolicy,
};
export function createOpenClawCodingTools(options) {
    const execToolName = "exec";
    const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
    const isMemoryFlushRun = options?.trigger === "memory";
    if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
        throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
    }
    const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : undefined;
    const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow, } = resolveEffectiveToolPolicy({
        config: options?.config,
        sessionKey: options?.sessionKey,
        agentId: options?.agentId,
        modelProvider: options?.modelProvider,
        modelId: options?.modelId,
    });
    // Prefer the already-resolved sandbox context policy. Recomputing from
    // sessionKey/config can lose the real sandbox agent when callers pass a
    // legacy alias like `main` instead of an agent session key.
    const sandboxToolPolicy = sandbox?.tools;
    const groupPolicy = resolveGroupToolPolicy({
        config: options?.config,
        sessionKey: options?.sessionKey,
        spawnedBy: options?.spawnedBy,
        messageProvider: options?.messageProvider,
        groupId: options?.groupId,
        groupChannel: options?.groupChannel,
        groupSpace: options?.groupSpace,
        accountId: options?.agentAccountId,
        senderId: options?.senderId,
        senderName: options?.senderName,
        senderUsername: options?.senderUsername,
        senderE164: options?.senderE164,
    });
    const profilePolicy = resolveToolProfilePolicy(profile);
    const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
    const runtimeProfileAlsoAllow = options?.forceMessageTool ? ["message"] : [];
    const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [
        ...(profileAlsoAllow ?? []),
        ...runtimeProfileAlsoAllow,
    ]);
    const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [
        ...(providerProfileAlsoAllow ?? []),
        ...runtimeProfileAlsoAllow,
    ]);
    // Prefer sessionKey for process isolation scope to prevent cross-session process visibility/killing.
    // Fallback to agentId if no sessionKey is available (e.g. legacy or global contexts).
    const scopeKey = options?.exec?.scopeKey ?? options?.sessionKey ?? (agentId ? `agent:${agentId}` : undefined);
    const subagentStore = resolveSubagentCapabilityStore(options?.sessionKey, {
        cfg: options?.config,
    });
    const subagentPolicy = options?.sessionKey &&
        isSubagentEnvelopeSession(options.sessionKey, {
            cfg: options.config,
            store: subagentStore,
        })
        ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey, {
            store: subagentStore,
        })
        : undefined;
    const allowBackground = isToolAllowedByPolicies("process", [
        profilePolicyWithAlsoAllow,
        providerProfilePolicyWithAlsoAllow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandboxToolPolicy,
        subagentPolicy,
    ]);
    const execConfig = resolveExecConfig({ cfg: options?.config, agentId });
    const fsConfig = resolveToolFsConfig({ cfg: options?.config, agentId });
    const fsPolicy = createToolFsPolicy({
        workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly,
    });
    const sandboxRoot = sandbox?.workspaceDir;
    const sandboxFsBridge = sandbox?.fsBridge;
    const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
    const workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir);
    const workspaceOnly = fsPolicy.workspaceOnly;
    const applyPatchConfig = execConfig.applyPatch;
    // Secure by default: apply_patch is workspace-contained unless explicitly disabled.
    // (tools.fs.workspaceOnly is a separate umbrella flag for read/write/edit/apply_patch.)
    const applyPatchWorkspaceOnly = workspaceOnly || applyPatchConfig?.workspaceOnly !== false;
    const applyPatchEnabled = applyPatchConfig?.enabled !== false &&
        isOpenAIProvider(options?.modelProvider) &&
        isApplyPatchAllowedForModel({
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            allowModels: applyPatchConfig?.allowModels,
        });
    if (sandboxRoot && !sandboxFsBridge) {
        throw new Error("Sandbox filesystem bridge is unavailable.");
    }
    const imageSanitization = resolveImageSanitizationLimits(options?.config);
    const base = createCodingTools(workspaceRoot).flatMap((tool) => {
        if (tool.name === "read") {
            if (sandboxRoot) {
                const sandboxed = createSandboxedReadTool({
                    root: sandboxRoot,
                    bridge: sandboxFsBridge,
                    modelContextWindowTokens: options?.modelContextWindowTokens,
                    imageSanitization,
                });
                return [
                    workspaceOnly
                        ? wrapToolWorkspaceRootGuardWithOptions(sandboxed, sandboxRoot, {
                            containerWorkdir: sandbox.containerWorkdir,
                        })
                        : sandboxed,
                ];
            }
            const freshReadTool = createReadTool(workspaceRoot);
            const wrapped = createOpenClawReadTool(freshReadTool, {
                modelContextWindowTokens: options?.modelContextWindowTokens,
                imageSanitization,
            });
            return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
        }
        if (tool.name === "bash" || tool.name === execToolName) {
            return [];
        }
        if (tool.name === "write") {
            if (sandboxRoot) {
                return [];
            }
            const wrapped = createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly });
            return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
        }
        if (tool.name === "edit") {
            if (sandboxRoot) {
                return [];
            }
            const wrapped = createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly });
            return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
        }
        return [tool];
    });
    const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
    const execTool = createLazyExecTool({
        ...execDefaults,
        host: options?.exec?.host ?? execConfig.host,
        security: options?.exec?.security ?? execConfig.security,
        ask: options?.exec?.ask ?? execConfig.ask,
        trigger: options?.trigger,
        node: options?.exec?.node ?? execConfig.node,
        pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
        safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
        strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
        safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
        safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
        agentId,
        cwd: workspaceRoot,
        allowBackground,
        scopeKey,
        sessionKey: options?.sessionKey,
        messageProvider: options?.messageProvider,
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        accountId: options?.agentAccountId,
        backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
        timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
        approvalRunningNoticeMs: options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
        notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
        notifyOnExitEmptySuccess: options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess,
        sandbox: sandbox
            ? {
                containerName: sandbox.containerName,
                workspaceDir: sandbox.workspaceDir,
                containerWorkdir: sandbox.containerWorkdir,
                env: sandbox.backend?.env ?? sandbox.docker.env,
                buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
                finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
            }
            : undefined,
    });
    const processTool = createLazyProcessTool({
        cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
        scopeKey,
    });
    const applyPatchTool = !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
        ? null
        : createApplyPatchTool({
            cwd: sandboxRoot ?? workspaceRoot,
            sandbox: sandboxRoot && allowWorkspaceWrites
                ? { root: sandboxRoot, bridge: sandboxFsBridge }
                : undefined,
            workspaceOnly: applyPatchWorkspaceOnly,
        });
    const tools = [
        ...base,
        ...(sandboxRoot
            ? allowWorkspaceWrites
                ? [
                    workspaceOnly
                        ? wrapToolWorkspaceRootGuardWithOptions(createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge }), sandboxRoot, {
                            containerWorkdir: sandbox.containerWorkdir,
                        })
                        : createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge }),
                    workspaceOnly
                        ? wrapToolWorkspaceRootGuardWithOptions(createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge }), sandboxRoot, {
                            containerWorkdir: sandbox.containerWorkdir,
                        })
                        : createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge }),
                ]
                : []
            : []),
        ...(applyPatchTool ? [applyPatchTool] : []),
        execTool,
        processTool,
        // Channel docking: include channel-defined agent tools (login, etc.).
        ...listChannelAgentTools({ cfg: options?.config }),
        ...createOpenClawTools({
            sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
            allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
            agentSessionKey: options?.sessionKey,
            agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
            agentAccountId: options?.agentAccountId,
            agentTo: options?.messageTo,
            agentThreadId: options?.messageThreadId,
            agentGroupId: options?.groupId ?? null,
            agentGroupChannel: options?.groupChannel ?? null,
            agentGroupSpace: options?.groupSpace ?? null,
            agentMemberRoleIds: options?.memberRoleIds,
            agentDir: options?.agentDir,
            sandboxRoot,
            sandboxContainerWorkdir: sandbox?.containerWorkdir,
            sandboxFsBridge,
            fsPolicy,
            workspaceDir: workspaceRoot,
            spawnWorkspaceDir: options?.spawnWorkspaceDir
                ? resolveWorkspaceRoot(options.spawnWorkspaceDir)
                : undefined,
            sandboxed: !!sandbox,
            config: options?.config,
            pluginToolAllowlist: collectExplicitAllowlist([
                profilePolicy,
                providerProfilePolicy,
                globalPolicy,
                globalProviderPolicy,
                agentPolicy,
                agentProviderPolicy,
                groupPolicy,
                sandboxToolPolicy,
                subagentPolicy,
            ]),
            currentChannelId: options?.currentChannelId,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            replyToMode: options?.replyToMode,
            hasRepliedRef: options?.hasRepliedRef,
            modelHasVision: options?.modelHasVision,
            requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
            disableMessageTool: options?.disableMessageTool,
            requesterAgentIdOverride: agentId,
            requesterSenderId: options?.senderId,
            senderIsOwner: options?.senderIsOwner,
            sessionId: options?.sessionId,
            onYield: options?.onYield,
            allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
        }),
    ];
    const toolsForMemoryFlush = isMemoryFlushRun && memoryFlushWritePath
        ? tools.flatMap((tool) => {
            if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
                return [];
            }
            if (tool.name === "write") {
                return [
                    wrapToolMemoryFlushAppendOnlyWrite(tool, {
                        root: sandboxRoot ?? workspaceRoot,
                        relativePath: memoryFlushWritePath,
                        containerWorkdir: sandbox?.containerWorkdir,
                        sandbox: sandboxRoot && sandboxFsBridge
                            ? { root: sandboxRoot, bridge: sandboxFsBridge }
                            : undefined,
                    }),
                ];
            }
            return [tool];
        })
        : tools;
    const toolsForMessageProvider = filterToolsByMessageProvider(toolsForMemoryFlush, options?.messageProvider);
    const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
        config: options?.config,
        modelProvider: options?.modelProvider,
        modelApi: options?.modelApi,
        modelId: options?.modelId,
        agentDir: options?.agentDir,
        modelCompat: options?.modelCompat,
    });
    // Security: treat unknown/undefined as unauthorized (opt-in, not opt-out)
    const senderIsOwner = options?.senderIsOwner === true;
    const toolsByAuthorization = applyOwnerOnlyToolPolicy(toolsForModelProvider, senderIsOwner);
    const subagentFiltered = applyToolPolicyPipeline({
        tools: toolsByAuthorization,
        toolMeta: (tool) => getPluginToolMeta(tool),
        warn: logWarn,
        steps: [
            ...buildDefaultToolPolicyPipelineSteps({
                profilePolicy: profilePolicyWithAlsoAllow,
                profile,
                profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
                providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
                providerProfile,
                providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
                globalPolicy,
                globalProviderPolicy,
                agentPolicy,
                agentProviderPolicy,
                groupPolicy,
                agentId,
            }),
            { policy: sandboxToolPolicy, label: "sandbox tools.allow" },
            { policy: subagentPolicy, label: "subagent tools.allow" },
        ],
    });
    // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
    // Without this, some providers (notably OpenAI) will reject root-level union schemas.
    // Provider-specific cleaning: Gemini needs constraint keywords stripped, but Anthropic expects them.
    const normalized = subagentFiltered.map((tool) => normalizeToolParameters(tool, {
        modelProvider: options?.modelProvider,
        modelId: options?.modelId,
        modelCompat: options?.modelCompat,
    }));
    const withHooks = normalized.map((tool) => wrapToolWithBeforeToolCallHook(tool, {
        agentId,
        sessionKey: options?.sessionKey,
        sessionId: options?.sessionId,
        runId: options?.runId,
        ...(options?.trace ? { trace: options.trace } : {}),
        loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId }),
    }));
    const withAbort = options?.abortSignal
        ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
        : withHooks;
    const withDeferredFollowupDescriptions = applyDeferredFollowupToolDescriptions(withAbort, {
        agentId,
    });
    // NOTE: Keep canonical (lowercase) tool names here.
    // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
    // on the wire and maps them back for tool dispatch.
    return withDeferredFollowupDescriptions;
}
