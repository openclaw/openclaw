import path from "node:path";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import { renderAgentWorkspaceInstructionSnapshot } from "./workspace-instruction-snapshot.js";

/** Renders already-bounded agent instructions without changing bootstrap budgets. */
export function buildAgentWorkspaceInstructionSnapshot(
  contextFiles: readonly EmbeddedContextFile[],
  workspaceDir: string,
): { files: EmbeddedContextFile[]; instructions: string } {
  return renderAgentWorkspaceInstructionSnapshot(
    selectAgentWorkspaceInstructionFiles(contextFiles, workspaceDir),
  );
}

/** Selects only the configured workspace's root instruction document. */
export function selectAgentWorkspaceInstructionFiles<T extends { path: string }>(
  files: readonly T[],
  workspaceDir: string,
): T[] {
  const instructionsPath = path.join(path.resolve(workspaceDir), "AGENTS.md");
  return files.filter((file) => path.resolve(file.path) === instructionsPath);
}
