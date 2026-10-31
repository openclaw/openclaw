import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";

/**
 * Renders root instruction files already selected by source path, after any path projection.
 * Internal: SDK-exported modules import it, so it lives apart to keep their declarations unchanged.
 */
export function renderAgentWorkspaceInstructionSnapshot(
  selectedFiles: readonly EmbeddedContextFile[],
): { files: EmbeddedContextFile[]; instructions: string } {
  const files = selectedFiles.filter(
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
