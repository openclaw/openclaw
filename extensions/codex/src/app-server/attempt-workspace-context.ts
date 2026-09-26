import path from "node:path";
import {
  buildAgentWorkspaceInstructionSnapshot,
  buildBootstrapContextForFiles,
  prepareAgentWorkspaceContext,
  embeddedAgentLog,
  type EmbeddedContextFile,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveBootstrapFilesForPreparation } from "openclaw/plugin-sdk/codex-mcp-projection";
import { isMessageOnlyCodexSourceReply } from "./dynamic-tool-profile.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

export const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
export const CODEX_MEMORY_CONTEXT_BASENAME = "memory.md";
const CODEX_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["user.md", 30],
  ["bootstrap.md", 50],
  ["memory.md", 60],
]);

export type CodexBootstrapFile = Awaited<
  ReturnType<typeof prepareAgentWorkspaceContext>
>["bootstrapFiles"][number];
type CodexBootstrapContext = {
  bootstrapFiles: CodexBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
export type CodexWorkspaceBootstrapContext = CodexBootstrapContext & {
  inheritsAgentWorkspace: boolean;
  promptContextFiles?: EmbeddedContextFile[];
  threadDeveloperInstructionFiles?: EmbeddedContextFile[];
  turnScopedDeveloperInstructionFiles?: EmbeddedContextFile[];
  memoryReferenceFiles?: EmbeddedContextFile[];
  memoryToolRoutedBootstrapFiles?: CodexBootstrapFile[];
  memoryToolNames?: string[];
  memoryToolRouted?: boolean;
  promptContext?: string;
  threadDeveloperInstructions?: string;
  turnScopedDeveloperInstructions?: string;
  memoryCollaborationInstructions?: string;
};

/** A child baseline reads the bounded workspace snapshot without invoking admission hooks. */
export async function prepareCodexWorkspaceDeveloperInstructions(params: {
  config: EmbeddedRunAttemptParams["config"];
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  cwd: string;
}): Promise<string | undefined> {
  if (isSameCodexWorkspacePath(params.workspaceDir, params.cwd)) {
    return undefined;
  }
  const files = await resolveBootstrapFilesForPreparation(params);
  const contextFiles = buildBootstrapContextForFiles(files, {
    config: params.config,
    agentId: params.agentId,
  });
  return buildAgentWorkspaceInstructionSnapshot(contextFiles, params.workspaceDir).instructions;
}

export async function buildCodexWorkspaceBootstrapContext(params: {
  params: EmbeddedRunAttemptParams;
  agentWorkspaceDeveloperInstructions?: string;
  resolvedWorkspace: string;
  executionWorkspace?: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
  tools: readonly CodexDynamicToolSpec[];
  ringZeroActive: boolean;
  sandboxed?: boolean;
}): Promise<CodexWorkspaceBootstrapContext> {
  const availableToolNames = new Set(
    flattenCodexDynamicToolFunctions(params.tools).map((tool) =>
      normalizeCodexDynamicToolName(tool.name),
    ),
  );
  const memoryToolNames = Array.from(CODEX_MEMORY_TOOL_NAMES).filter((name) =>
    availableToolNames.has(name),
  );
  const executionWorkspace = params.executionWorkspace ?? params.resolvedWorkspace;
  const inheritsAgentWorkspace = executionWorkspace !== params.resolvedWorkspace;
  const injectOpenClawContext = shouldInjectCodexOpenClawPromptContext(params.params);
  const restrictedProjectDocNeedsOpenClawCarrier =
    params.params.pluginHarnessToolPolicyRestricted === true &&
    !params.params.disableTools &&
    !isMessageOnlyCodexSourceReply(params.params) &&
    params.params.bootstrapContextMode !== "lightweight";
  const includeAgentWorkspaceInstructions =
    injectOpenClawContext &&
    !params.ringZeroActive &&
    (inheritsAgentWorkspace || restrictedProjectDocNeedsOpenClawCarrier);
  try {
    const promptWorkspace = inheritsAgentWorkspace
      ? params.resolvedWorkspace
      : params.effectiveWorkspace;
    const memoryToolsAvailable =
      memoryToolNames.length > 0 &&
      canRouteCodexWorkspaceMemoryThroughTools({
        config: params.params.config,
        agentId: params.params.agentId ?? params.sessionAgentId,
        workspaceDir: inheritsAgentWorkspace ? params.resolvedWorkspace : params.effectiveWorkspace,
      });
    const prepared = await prepareAgentWorkspaceContext({
      scope: "full",
      workspaceDir: params.resolvedWorkspace,
      config: params.params.config,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      bootstrapUserProfileId: params.params.bootstrapUserProfileId,
      chatType: params.params.chatType,
      agentId: params.params.agentId ?? params.sessionAgentId,
      warn: (message) => embeddedAgentLog.warn(message),
      contextMode: params.params.bootstrapContextMode,
      runKind: params.params.bootstrapContextRunKind,
      memoryToolRouted: memoryToolsAvailable,
      onMemoryPreparationError: (error) =>
        embeddedAgentLog.warn("failed to prepare codex memory recall instructions", { error }),
      memoryTools: injectOpenClawContext
        ? {
            toolNames: [...availableToolNames],
            citationsMode: params.params.config?.memory?.citations,
            sandboxed: params.sandboxed,
          }
        : undefined,
      projectPath: (filePath) =>
        remapCodexContextFilePath({
          filePath,
          sourceWorkspaceDir: params.resolvedWorkspace,
          targetWorkspaceDir: promptWorkspace,
        }),
      nativeProjectDocBasenames: CODEX_NATIVE_PROJECT_DOC_BASENAMES,
      contextFileOrder: CODEX_BOOTSTRAP_CONTEXT_ORDER,
      promptMemoryWorkspaceDir: params.effectiveWorkspace,
    });
    const {
      bootstrapFiles,
      contextFiles,
      promptContextFiles,
      memoryReferenceFiles,
      memoryToolRoutedBootstrapFiles,
    } = prepared;
    const threadDeveloperInstructionFiles = includeAgentWorkspaceInstructions
      ? prepared.instructionSnapshot.files
      : [];
    const turnScopedDeveloperInstructionFiles = injectOpenClawContext ? prepared.personaFiles : [];
    return {
      bootstrapFiles,
      contextFiles,
      inheritsAgentWorkspace,
      promptContextFiles,
      threadDeveloperInstructionFiles,
      turnScopedDeveloperInstructionFiles,
      memoryReferenceFiles,
      memoryToolRoutedBootstrapFiles,
      memoryToolNames,
      memoryToolRouted: memoryToolsAvailable,
      promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
      // Empty is a captured snapshot too; a missing value still permits first capture.
      threadDeveloperInstructions: includeAgentWorkspaceInstructions
        ? (params.agentWorkspaceDeveloperInstructions ?? prepared.instructionSnapshot.instructions)
        : undefined,
      turnScopedDeveloperInstructions: injectOpenClawContext
        ? prepared.personaInstructions
        : undefined,
      memoryCollaborationInstructions: injectOpenClawContext
        ? renderCodexWorkspaceMemoryCollaborationInstructions({
            files: memoryReferenceFiles,
            toolNames: memoryToolNames,
            memoryRecallInstructions: prepared.memoryRecallInstructions,
          })
        : undefined,
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to load codex workspace bootstrap instructions", { error });
    return {
      bootstrapFiles: [],
      contextFiles: [],
      inheritsAgentWorkspace,
      threadDeveloperInstructions: includeAgentWorkspaceInstructions
        ? params.agentWorkspaceDeveloperInstructions
        : undefined,
    };
  }
}

export function shouldInjectCodexOpenClawPromptContext(params: EmbeddedRunAttemptParams): boolean {
  // Lightweight cron runs are commonly exact commands. Keep the user input byte-for-byte
  // to avoid changing command intent while Codex keeps its native project-doc loader.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

function renderCodexWorkspaceBootstrapPromptContext(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  if (contextFiles.length === 0) {
    return undefined;
  }
  const lines = [
    "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads project-local AGENTS.md natively. When execution uses another folder, OpenClaw supplies the agent workspace AGENTS.md as thread-level developer instructions. SOUL.md, IDENTITY.md, and USER.md are prepared separately from user input and are not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
    "",
  ];
  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function renderCodexWorkspaceMemoryReference(params: {
  files: EmbeddedContextFile[];
  toolNames?: readonly string[];
}): string | undefined {
  if (params.files.length === 0) {
    return undefined;
  }
  const toolNames = params.toolNames?.length
    ? params.toolNames
    : Array.from(CODEX_MEMORY_TOOL_NAMES);
  const lines = [
    "## OpenClaw Workspace Memory",
    "",
    `MEMORY.md exists in the active agent workspace as a memory file, not an instruction file. OpenClaw does not paste its contents into native Codex turns; use ${toolNames.join(" or ")} when durable memory is relevant and the tools are available.`,
    "",
  ];
  for (const file of params.files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

function renderCodexWorkspaceMemoryCollaborationInstructions(params: {
  files: EmbeddedContextFile[];
  toolNames: readonly string[];
  memoryRecallInstructions?: string;
}): string | undefined {
  const memoryRecallInstructions = params.memoryRecallInstructions
    ? [params.memoryRecallInstructions, renderCodexMemoryToolSearchBridge(params.toolNames)]
        .filter(isNonEmptyString)
        .join("\n")
        .trim()
    : undefined;
  const memoryReferenceInstructions = renderCodexWorkspaceMemoryReference(params);
  const sections = [memoryRecallInstructions, memoryReferenceInstructions].filter(isNonEmptyString);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function renderCodexMemoryToolSearchBridge(toolNames: readonly string[]): string | undefined {
  const memoryToolNames = toolNames
    .map((name) => normalizeCodexDynamicToolName(name))
    .filter((name) => CODEX_MEMORY_TOOL_NAMES.has(name))
    .toSorted();
  if (memoryToolNames.length === 0) {
    return undefined;
  }
  return `Codex may expose ${memoryToolNames.join(" and ")} as deferred tools. When the memory guidance above calls for memory recall, use an already-loaded memory tool directly. If the needed memory tool is deferred and not currently callable, use \`tool_search\` to load it, then call that memory tool.`;
}

function canRouteCodexWorkspaceMemoryThroughTools(params: {
  config: EmbeddedRunAttemptParams["config"] | undefined;
  agentId: string;
  workspaceDir: string;
}): boolean {
  if (!params.config) {
    return false;
  }
  return isSameCodexWorkspacePath(
    resolveAgentWorkspaceDir(params.config, params.agentId),
    params.workspaceDir,
  );
}

function isSameCodexWorkspacePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Remaps bootstrap file paths from the resolved workspace to the effective Codex
 * workspace while preserving platform path separators.
 */
function remapCodexContextFilePath(params: {
  filePath: string;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): string {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.filePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    params.sourceWorkspaceDir === params.targetWorkspaceDir
  ) {
    return params.filePath;
  }
  const targetUsesPosixSeparators =
    params.targetWorkspaceDir.includes("/") && !params.targetWorkspaceDir.includes("\\");
  const normalizedRelativePath = targetUsesPosixSeparators
    ? relativePath.replaceAll("\\", "/")
    : relativePath.replaceAll("/", "\\");
  return targetUsesPosixSeparators
    ? path.posix.join(params.targetWorkspaceDir, normalizedRelativePath)
    : path.win32.join(params.targetWorkspaceDir, normalizedRelativePath);
}

export function normalizeCodexContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

export function getCodexContextFileDisplayBasename(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
}

export function getCodexContextFileBasename(filePath: string): string {
  return normalizeCodexContextFilePath(filePath).split("/").pop() ?? "";
}

export function normalizeCodexDynamicToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
