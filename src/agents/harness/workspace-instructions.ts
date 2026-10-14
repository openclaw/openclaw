import path from "node:path";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";

/** Projects already-bounded agent instructions without changing bootstrap budgets. */
export function buildAgentWorkspaceInstructionSnapshot(
  contextFiles: readonly EmbeddedContextFile[],
  workspaceDir: string,
): { files: EmbeddedContextFile[]; instructions: string } {
  const files = selectAgentWorkspaceInstructionFiles(contextFiles, workspaceDir).filter(
    (file) =>
      !file.content.trimStart().startsWith("[MISSING] Expected at:") &&
      file.content.trim().length > 0,
  );
  if (files.length === 0) {
    // Empty is a successful capture; callers distinguish it from preparation failure.
    return { files, instructions: "" };
  }
  const lines = [
    "## OpenClaw Agent Workspace Instructions",
    "",
    "OpenClaw loaded this bounded snapshot from the configured agent workspace.",
    "",
  ];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  return { files, instructions: lines.join("\n").trim() };
}

/** Selects only the configured workspace's root instruction document. */
export function selectAgentWorkspaceInstructionFiles<T extends { path: string }>(
  files: readonly T[],
  workspaceDir: string,
): T[] {
  const instructionsPath = path.join(path.resolve(workspaceDir), "AGENTS.md");
  return files.filter((file) => path.resolve(file.path) === instructionsPath);
}
