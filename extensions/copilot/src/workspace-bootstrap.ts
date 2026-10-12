import path from "node:path";
import type {
  AgentHarnessAttemptParamsV2,
  EmbeddedContextFile,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveBootstrapContextForRun,
  resolveUserPath,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";

// The SDK loads AGENTS.md from its instruction directories; do not inject it twice.
const COPILOT_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);

// Persona and identity precede free-form user context.
const COPILOT_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["heartbeat.md", 30],
  ["bootstrap.md", 40],
  ["tools.md", 50],
  ["user.md", 60],
  ["memory.md", 70],
]);

export async function loadCopilotWorkspaceInstructions(params: {
  attempt: AgentHarnessAttemptParamsV2;
  /** SDK workspace after sandbox resolution; undefined before resolution. */
  effectiveWorkspaceDir: string | undefined;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const { attempt } = params;
  const workspaceDir = readResolvedWorkspacePath(attempt.workspaceDir);
  if (!workspaceDir) {
    return undefined;
  }
  try {
    const bootstrapContext = await resolveBootstrapContextForRun({
      workspaceDir,
      config: attempt.config,
      sessionKey: readNonBlankString((attempt as { sessionKey?: unknown }).sessionKey),
      sessionId: readNonBlankString(attempt.sessionId),
      chatType: attempt.chatType,
      agentId: readNonBlankString(attempt.agentId),
      warn: params.warn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
    });
    // Render the paths seen by sandboxed tools, while loading from the host workspace.
    const contextFiles = remapCopilotBootstrapContextFiles({
      files: bootstrapContext.contextFiles,
      sourceWorkspaceDir: workspaceDir,
      targetWorkspaceDir: readResolvedWorkspacePath(params.effectiveWorkspaceDir) ?? workspaceDir,
    });
    return renderCopilotWorkspaceBootstrapInstructions(contextFiles);
  } catch (error) {
    params.warn?.(
      `[copilot-attempt] failed to load workspace bootstrap instructions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// Files outside the workspace must retain their actual location.
function remapCopilotBootstrapContextFiles(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    if (!isRelativePathInsideOrEqual(relative)) {
      return file;
    }
    return {
      ...file,
      path:
        relative === ""
          ? params.targetWorkspaceDir
          : path.join(params.targetWorkspaceDir, relative),
    };
  });
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function renderCopilotWorkspaceBootstrapInstructions(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = contextFiles
    .filter((file) => {
      const baseName = getCopilotContextFileBasename(file.path);
      return baseName.length > 0 && !COPILOT_NATIVE_PROJECT_DOC_BASENAMES.has(baseName);
    })
    .toSorted(compareCopilotContextFiles);
  if (files.length === 0) {
    return undefined;
  }
  const hasSoulFile = files.some((file) => getCopilotContextFileBasename(file.path) === "soul.md");
  const lines: string[] = [
    "OpenClaw loaded these user-editable workspace files. Treat them as project/user context. The Copilot SDK loads AGENTS.md natively from its instruction directories, so AGENTS.md is not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  if (hasSoulFile) {
    lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
  }
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function compareCopilotContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftBase = getCopilotContextFileBasename(left.path);
  const rightBase = getCopilotContextFileBasename(right.path);
  const leftOrder = COPILOT_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = COPILOT_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftPath = normalizeCopilotContextFilePath(left.path);
  const rightPath = normalizeCopilotContextFilePath(right.path);
  if (leftPath < rightPath) {
    return -1;
  }
  if (leftPath > rightPath) {
    return 1;
  }
  return 0;
}

function normalizeCopilotContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

function getCopilotContextFileBasename(filePath: string): string {
  return normalizeCopilotContextFilePath(filePath).split("/").pop() ?? "";
}

function readResolvedWorkspacePath(value: unknown): string | undefined {
  const raw = readNonBlankString(value);
  if (!raw) {
    return undefined;
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw.trim();
  }
  return resolveUserPath(raw);
}
