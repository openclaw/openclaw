import path from "node:path";
import { prepareMemorySystemPromptAddition } from "../../context-engine/delegate.js";
import { buildBootstrapContextForFiles, resolveBootstrapFilesForRun } from "../bootstrap-files.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import {
  PERSONAL_USER_CONTEXT_INSTRUCTIONS,
  prepareContextFilesForPrompt,
} from "../system-prompt-context-files.js";
import {
  buildAgentWorkspaceInstructionSnapshot,
  selectAgentWorkspaceInstructionFiles,
} from "./workspace-instructions.js";

type BootstrapFile = Awaited<ReturnType<typeof resolveBootstrapFilesForRun>>[number];

export type AgentWorkspaceContextParams = Parameters<typeof resolveBootstrapFilesForRun>[0] & {
  scope: "full" | "instructions-only";
  memoryToolRouted?: boolean;
  memoryTools?: {
    /** Complete policy-admitted tool set available to the active memory prompt builder. */
    toolNames: readonly string[];
    citationsMode?: Parameters<typeof prepareMemorySystemPromptAddition>[0]["citationsMode"];
    sandboxed?: boolean;
  };
  projectPath?: (filePath: string) => string;
  nativeProjectDocBasenames?: ReadonlySet<string>;
  contextFileOrder?: ReadonlyMap<string, number>;
  promptMemoryWorkspaceDir?: string;
  onMemoryPreparationError?: (error: unknown) => void;
};

export type AgentWorkspaceContext = {
  bootstrapFiles: BootstrapFile[];
  contextFiles: EmbeddedContextFile[];
  instructionSnapshot: ReturnType<typeof buildAgentWorkspaceInstructionSnapshot>;
  personaFiles: EmbeddedContextFile[];
  personaInstructions?: string;
  promptContextFiles: EmbeddedContextFile[];
  memoryReferenceFiles: EmbeddedContextFile[];
  memoryToolRoutedBootstrapFiles: BootstrapFile[];
  memoryRecallInstructions?: string;
};

/** Prepares Gateway workspace facts; the harness owns their native carriers and lifetime. */
export async function prepareAgentWorkspaceContext(
  params: AgentWorkspaceContextParams,
): Promise<AgentWorkspaceContext> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const instructionsOnly = params.scope === "instructions-only";
  const memoryToolRouted = !instructionsOnly && params.memoryToolRouted === true;
  const memoryToolRoutedBootstrapFiles = memoryToolRouted
    ? prepareContextFilesForPrompt(
        bootstrapFiles
          .filter(
            (file) =>
              isRootMemoryPath(file.path, params.workspaceDir) &&
              !file.missing &&
              (file.content ?? "").trim().length > 0,
          )
          .map((file) => Object.assign(toContextFile(file), { bootstrapFile: file })),
        { order: params.contextFileOrder, caseInsensitivePathOrder: true, trimBasename: false },
      ).map(({ file }) => file.bootstrapFile)
    : [];
  const budgetFiles = instructionsOnly
    ? selectAgentWorkspaceInstructionFiles(bootstrapFiles, params.workspaceDir).filter(
        (file) => !file.missing,
      )
    : memoryToolRouted
      ? bootstrapFiles.filter((file) => !isRootMemoryPath(file.path, params.workspaceDir))
      : bootstrapFiles;
  const contextFiles = buildBootstrapContextForFiles(budgetFiles, params).map((file) =>
    projectContextFile(file, params.projectPath),
  );
  const instructionSnapshot = buildAgentWorkspaceInstructionSnapshot(
    contextFiles,
    params.workspaceDir,
  );
  if (instructionsOnly) {
    return {
      bootstrapFiles,
      contextFiles,
      instructionSnapshot,
      personaFiles: [],
      promptContextFiles: [],
      memoryReferenceFiles: [],
      memoryToolRoutedBootstrapFiles: [],
    };
  }
  const personaFiles = sortContextFiles(
    contextFiles.filter(
      (file) =>
        PERSONA_FILE_BASENAMES.has(contextFileBasename(file.path)) &&
        !isMissingContextFile(file) &&
        file.content.trim().length > 0,
    ),
    params.contextFileOrder,
  );
  const promptContextFiles = sortContextFiles(
    contextFiles.filter((file) => {
      const basename = contextFileBasename(file.path);
      const nativeProjectDocument = params.nativeProjectDocBasenames
        ? params.nativeProjectDocBasenames.has(basename)
        : selectAgentWorkspaceInstructionFiles([file], params.workspaceDir).length > 0;
      return (
        basename.length > 0 &&
        !nativeProjectDocument &&
        !PERSONA_FILE_BASENAMES.has(basename) &&
        (!memoryToolRouted ||
          !isRootMemoryPath(file.path, params.promptMemoryWorkspaceDir ?? params.workspaceDir)) &&
        !isMissingContextFile(file)
      );
    }),
    params.contextFileOrder,
  );
  const memoryReferenceFiles = memoryToolRoutedBootstrapFiles.map((file) =>
    projectContextFile(toContextFile(file), params.projectPath),
  );
  // Provider guidance is independent of file routing; failure must preserve the instruction snapshot.
  const memoryRecallInstructions = params.memoryTools
    ? await prepareMemorySystemPromptAddition({
        availableTools: new Set(params.memoryTools.toolNames),
        citationsMode: params.memoryTools.citationsMode,
        agentId: params.agentId,
        agentSessionKey: params.sessionKey,
        sandboxed: params.memoryTools.sandboxed,
      }).catch((error: unknown) => {
        if (params.onMemoryPreparationError) {
          params.onMemoryPreparationError(error);
        } else {
          params.warn?.(`failed to prepare workspace memory recall instructions: ${String(error)}`);
        }
        return undefined;
      })
    : undefined;
  return {
    bootstrapFiles,
    contextFiles,
    instructionSnapshot,
    personaFiles,
    personaInstructions: renderPersonaInstructions(personaFiles),
    promptContextFiles,
    memoryReferenceFiles,
    memoryToolRoutedBootstrapFiles,
    memoryRecallInstructions,
  };
}

const PERSONA_FILE_BASENAMES = new Set(["identity.md", "soul.md", "user.md"]);

function renderPersonaInstructions(files: readonly EmbeddedContextFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const preamble =
    "OpenClaw loaded these workspace instruction files from the active agent workspace. They are the canonical definitions of who you are, how you think and work, and the human you work alongside. Internalize and follow them accordingly." +
    (files.some((file) => file.personalUser === true)
      ? ` ${PERSONAL_USER_CONTEXT_INSTRUCTIONS}`
      : "");
  const lines = ["## OpenClaw Agent Soul", "", preamble, "", "<AGENT_SOUL>", ""];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  lines.push("</AGENT_SOUL>");
  return lines.join("\n").trim();
}

function sortContextFiles(
  files: readonly EmbeddedContextFile[],
  order?: ReadonlyMap<string, number>,
): EmbeddedContextFile[] {
  return prepareContextFilesForPrompt(files, {
    order,
    caseInsensitivePathOrder: true,
    trimBasename: false,
  }).map(({ file }) => file);
}

function toContextFile(file: BootstrapFile): EmbeddedContextFile {
  return {
    path: file.path,
    content: file.content ?? "",
    ...(file.personalUser === true ? { personalUser: true } : {}),
  };
}

function projectContextFile(
  file: EmbeddedContextFile,
  projectPath?: (filePath: string) => string,
): EmbeddedContextFile {
  return projectPath ? { ...file, path: projectPath(file.path) } : file;
}

function isRootMemoryPath(filePath: string, workspaceDir: string): boolean {
  const normalized = filePath.trim();
  if (!normalized) {
    return false;
  }
  const absolutePath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspaceDir, normalized);
  return absolutePath === path.join(path.resolve(workspaceDir), "MEMORY.md");
}

function contextFileBasename(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase().split("/").pop() ?? "";
}

function isMissingContextFile(file: EmbeddedContextFile): boolean {
  return file.content.trimStart().startsWith("[MISSING] Expected at:");
}
