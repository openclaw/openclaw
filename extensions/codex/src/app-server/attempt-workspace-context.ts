/** Workspace snapshots, per-turn workspace context, and memory-tool routing for Codex. */
import path from "node:path";
import {
  buildBootstrapContextForFiles,
  embeddedAgentLog,
  resolveBootstrapFilesForRun,
  type EmbeddedContextFile,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveBootstrapFilesForPreparation } from "openclaw/plugin-sdk/codex-mcp-projection";
import {
  buildMemorySystemPromptAddition,
  prepareMemorySystemPromptAddition,
} from "openclaw/plugin-sdk/core";
import { readNonBlankString as readNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isMessageOnlyCodexSourceReply } from "./dynamic-tool-profile.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

export const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  "identity.md",
  "soul.md",
  "user.md",
]);
const CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set(
  CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
);
export const CODEX_MEMORY_CONTEXT_BASENAME = "memory.md";
const CODEX_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["user.md", 30],
  ["bootstrap.md", 50],
  ["memory.md", 60],
]);

export type CodexBootstrapFile = Awaited<ReturnType<typeof resolveBootstrapFilesForRun>>[number];
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
  return (
    renderCodexWorkspaceDeveloperInstructions({
      files: selectCodexWorkspaceAgentProjectInstructionFiles(contextFiles, params.workspaceDir),
      header: "## OpenClaw Agent Workspace Instructions",
      preamble: "OpenClaw loaded this bounded snapshot from the configured agent workspace.",
    }) ?? ""
  );
}

/** Loads and partitions workspace snapshots, turn instructions, and memory references. */
export async function buildCodexWorkspaceBootstrapContext(params: {
  params: EmbeddedRunAttemptParams;
  agentWorkspaceDeveloperInstructions?: string;
  resolvedWorkspace: string;
  executionWorkspace?: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
  memoryToolNames: readonly string[];
  ringZeroActive: boolean;
  sandboxed?: boolean;
}): Promise<CodexWorkspaceBootstrapContext> {
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
      params.memoryToolNames.length > 0 &&
      canRouteCodexWorkspaceMemoryThroughTools({
        config: params.params.config,
        agentId: params.params.agentId ?? params.sessionAgentId,
        workspaceDir: inheritsAgentWorkspace ? params.resolvedWorkspace : params.effectiveWorkspace,
      });
    // Native Codex turns should read workspace MEMORY.md through tools when
    // possible; pasting it into every prompt turns durable memory into policy.
    const bootstrapFiles = await resolveBootstrapFilesForRun({
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
    });
    const memoryToolRoutedBootstrapFiles = memoryToolsAvailable
      ? selectCodexWorkspaceMemoryReferenceFiles({
          bootstrapFiles,
          workspaceDir: params.resolvedWorkspace,
        })
      : [];
    const memoryReferenceFiles = memoryToolRoutedBootstrapFiles.map((file) =>
      remapCodexContextFilePath({
        file: toCodexEmbeddedContextFile(file),
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: promptWorkspace,
      }),
    );
    const contextFiles = buildBootstrapContextForFiles(
      memoryToolsAvailable
        ? bootstrapFiles.filter(
            (file) =>
              !isCodexWorkspaceRootMemoryBootstrapFile({
                file,
                workspaceDir: params.resolvedWorkspace,
              }),
          )
        : bootstrapFiles,
      {
        config: params.params.config,
        agentId: params.params.agentId ?? params.sessionAgentId,
        warn: (message) => embeddedAgentLog.warn(message),
      },
    ).map((file) =>
      remapCodexContextFilePath({
        file,
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: promptWorkspace,
      }),
    );
    const promptContextFiles = selectCodexWorkspacePromptContextFiles(contextFiles, {
      excludeMemory: memoryToolsAvailable,
      memoryWorkspaceDir: params.effectiveWorkspace,
    });
    const threadDeveloperInstructionFiles = includeAgentWorkspaceInstructions
      ? selectCodexWorkspaceAgentProjectInstructionFiles(contextFiles, params.resolvedWorkspace)
      : [];
    const turnScopedDeveloperInstructionFiles = injectOpenClawContext
      ? selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(contextFiles)
      : [];
    return {
      bootstrapFiles,
      contextFiles,
      inheritsAgentWorkspace,
      promptContextFiles,
      threadDeveloperInstructionFiles,
      turnScopedDeveloperInstructionFiles,
      memoryReferenceFiles,
      memoryToolRoutedBootstrapFiles,
      memoryToolNames: [...params.memoryToolNames],
      memoryToolRouted: memoryToolsAvailable,
      promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
      // Empty is a captured snapshot too; a missing value still permits first capture.
      threadDeveloperInstructions: includeAgentWorkspaceInstructions
        ? (params.agentWorkspaceDeveloperInstructions ??
          renderCodexWorkspaceDeveloperInstructions({
            files: threadDeveloperInstructionFiles,
            header: "## OpenClaw Agent Workspace Instructions",
            preamble: "OpenClaw loaded this bounded snapshot from the configured agent workspace.",
          }) ??
          "")
        : undefined,
      turnScopedDeveloperInstructions: renderCodexWorkspaceCollaborationDeveloperInstructions(
        turnScopedDeveloperInstructionFiles,
      ),
      memoryCollaborationInstructions: injectOpenClawContext
        ? await renderCodexWorkspaceMemoryCollaborationInstructions({
            files: memoryReferenceFiles,
            toolNames: params.memoryToolNames,
            memoryToolRouted: memoryToolsAvailable,
            citationsMode: params.params.config?.memory?.citations,
            agentId: params.params.agentId ?? params.sessionAgentId,
            agentSessionKey: params.sessionKey,
            sandboxed: params.sandboxed,
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
  const files = contextFiles;
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads project-local AGENTS.md natively. When execution uses another folder, OpenClaw supplies the agent workspace AGENTS.md as thread-level developer instructions. SOUL.md, IDENTITY.md, and USER.md are prepared separately from user input and are not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspacePromptContextFiles(
  contextFiles: EmbeddedContextFile[],
  options: { excludeMemory?: boolean; memoryWorkspaceDir?: string } = {},
): EmbeddedContextFile[] {
  const excludeMemory = options.excludeMemory ?? true;
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName) &&
        !CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) &&
        (!excludeMemory ||
          !isCodexWorkspaceRootMemoryContextFile({
            file,
            workspaceDir: options.memoryWorkspaceDir,
          })) &&
        !isMissingCodexBootstrapContextFile(file)
      );
    })
    .toSorted(compareCodexContextFiles);
}

function selectCodexWorkspaceTurnScopedDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_TURN_SCOPED_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES,
  );
}

function selectCodexWorkspaceAgentProjectInstructionFiles(
  contextFiles: EmbeddedContextFile[],
  agentWorkspaceDir: string,
): EmbeddedContextFile[] {
  const agentProjectDocPath = path.join(path.resolve(agentWorkspaceDir), "AGENTS.md");
  return selectCodexWorkspaceDeveloperInstructionFiles(
    contextFiles,
    CODEX_NATIVE_PROJECT_DOC_BASENAMES,
  ).filter((file) => path.resolve(file.path) === agentProjectDocPath);
}

function selectCodexWorkspaceDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
  basenames: ReadonlySet<string>,
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        basenames.has(baseName) &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceCollaborationDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  return renderCodexWorkspaceDeveloperInstructions({
    files,
    header: "## OpenClaw Agent Soul",
    preamble:
      "OpenClaw loaded these workspace instruction files from the active agent workspace. They are the canonical definitions of who you are, how you think and work, and the human you work alongside. Internalize and follow them accordingly." +
      (files.some((file) =>
        /(?:^|\/)users\/[^/]+\/user\.md$/.test(normalizeCodexContextFilePath(file.path)),
      )
        ? " The personal users/<profile-id>/USER.md applies only to the current requester and overrides conflicting shared USER.md preferences, not higher-priority rules."
        : ""),
    wrapperTag: "AGENT_SOUL",
  });
}

function renderCodexWorkspaceDeveloperInstructions(params: {
  files: EmbeddedContextFile[];
  header: string;
  preamble: string;
  wrapperTag?: string;
}): string | undefined {
  const { files, header, preamble, wrapperTag } = params;
  if (files.length === 0) {
    return undefined;
  }
  const lines = [header, "", preamble, ""];
  if (wrapperTag) {
    lines.push(`<${wrapperTag}>`, "");
  }
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  if (wrapperTag) {
    lines.push(`</${wrapperTag}>`);
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspaceMemoryReferenceFiles(params: {
  bootstrapFiles: CodexBootstrapFile[];
  workspaceDir: string;
}): CodexBootstrapFile[] {
  return params.bootstrapFiles
    .filter((file) => {
      return (
        isCodexWorkspaceRootMemoryBootstrapFile({
          file,
          workspaceDir: params.workspaceDir,
        }) &&
        !file.missing &&
        (file.content ?? "").trim().length > 0
      );
    })
    .toSorted(compareCodexBootstrapFiles);
}

/**
 * Renders a memory-file reference that points Codex at memory tools instead of
 * embedding MEMORY.md contents.
 */
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

async function renderCodexWorkspaceMemoryCollaborationInstructions(params: {
  files: EmbeddedContextFile[];
  toolNames: readonly string[];
  memoryToolRouted: boolean;
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): Promise<string | undefined> {
  const memoryRecallInstructions = params.memoryToolRouted
    ? await renderCodexMemoryRecallInstructions({
        toolNames: params.toolNames,
        citationsMode: params.citationsMode,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        sandboxed: params.sandboxed,
      })
    : undefined;
  const memoryReferenceInstructions = renderCodexWorkspaceMemoryReference({
    files: params.files,
    toolNames: params.toolNames,
  });
  const sections = [memoryRecallInstructions, memoryReferenceInstructions].filter(isNonEmptyString);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function renderCodexMemoryRecallInstructions(params: {
  toolNames: readonly string[];
  citationsMode?: Parameters<typeof buildMemorySystemPromptAddition>[0]["citationsMode"];
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): Promise<string | undefined> {
  const availableTools = new Set(params.toolNames);
  const memoryPrompt = await prepareMemorySystemPromptAddition({
    availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  }).catch((error: unknown) => {
    embeddedAgentLog.warn("failed to prepare codex memory recall instructions", { error });
    return undefined;
  });
  if (!memoryPrompt) {
    // Memory recall policy belongs to the active memory plugin.
    // Codex-side fallback text can mask plugin lifecycle bugs or misdescribe third-party memory tools.
    return undefined;
  }
  const toolSearchBridge = renderCodexMemoryToolSearchBridge(params.toolNames);
  return [memoryPrompt, toolSearchBridge].filter(isNonEmptyString).join("\n").trim();
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

/** Lists available memory tool names understood by Codex workspace memory routing. */
export function getCodexWorkspaceMemoryToolNames(tools: readonly CodexDynamicToolSpec[]): string[] {
  const availableToolNames = new Set(
    flattenCodexDynamicToolFunctions(tools).map((tool) => normalizeCodexDynamicToolName(tool.name)),
  );
  return Array.from(CODEX_MEMORY_TOOL_NAMES).filter((name) => availableToolNames.has(name));
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

function isMissingCodexBootstrapContextFile(file: EmbeddedContextFile): boolean {
  return file.content.trimStart().startsWith("[MISSING] Expected at:");
}

function toCodexEmbeddedContextFile(file: CodexBootstrapFile): EmbeddedContextFile {
  return {
    path: readNonEmptyString(file.path) ?? readNonEmptyString(file.name) ?? "",
    content: file.content ?? "",
  };
}

function isCodexWorkspaceRootMemoryBootstrapFile(params: {
  file: CodexBootstrapFile;
  workspaceDir: string;
}): boolean {
  return isCodexWorkspaceRootMemoryPath({
    filePath: readNonEmptyString(params.file.path) ?? readNonEmptyString(params.file.name) ?? "",
    workspaceDir: params.workspaceDir,
  });
}

function isCodexWorkspaceRootMemoryContextFile(params: {
  file: EmbeddedContextFile;
  workspaceDir?: string;
}): boolean {
  if (!params.workspaceDir) {
    return false;
  }
  return isCodexWorkspaceRootMemoryPath({
    filePath: params.file.path,
    workspaceDir: params.workspaceDir,
  });
}

function isCodexWorkspaceRootMemoryPath(params: {
  filePath: string;
  workspaceDir: string;
}): boolean {
  const filePath = params.filePath.trim();
  if (!filePath) {
    return false;
  }
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(params.workspaceDir, filePath);
  return absolutePath === path.join(path.resolve(params.workspaceDir), "MEMORY.md");
}

function isSameCodexWorkspacePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Remaps bootstrap file paths from the resolved workspace to the effective Codex
 * workspace while preserving platform path separators.
 */
function remapCodexContextFilePath(params: {
  file: EmbeddedContextFile;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    params.sourceWorkspaceDir === params.targetWorkspaceDir
  ) {
    return params.file;
  }
  const targetUsesPosixSeparators =
    params.targetWorkspaceDir.includes("/") && !params.targetWorkspaceDir.includes("\\");
  const normalizedRelativePath = targetUsesPosixSeparators
    ? relativePath.replaceAll("\\", "/")
    : relativePath.replaceAll("/", "\\");
  return {
    ...params.file,
    path: targetUsesPosixSeparators
      ? path.posix.join(params.targetWorkspaceDir, normalizedRelativePath)
      : path.win32.join(params.targetWorkspaceDir, normalizedRelativePath),
  };
}

function compareCodexContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftPath = normalizeCodexContextFilePath(left.path);
  const rightPath = normalizeCodexContextFilePath(right.path);
  const leftBase = getCodexContextFileBasename(left.path);
  const rightBase = getCodexContextFileBasename(right.path);
  const leftOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftBase !== rightBase) {
    return leftBase.localeCompare(rightBase);
  }
  // Keep USER overlays in loader order: shared defaults precede the current person.
  return leftBase === "user.md" ? 0 : leftPath.localeCompare(rightPath);
}

function compareCodexBootstrapFiles(left: CodexBootstrapFile, right: CodexBootstrapFile): number {
  return compareCodexContextFiles(
    toCodexEmbeddedContextFile(left),
    toCodexEmbeddedContextFile(right),
  );
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
