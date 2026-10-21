import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import type { KillTree } from "./subagent-control-kill-scope.js";

export function collectKillErrors(trees: KillTree[], unlabeledRoot?: KillTree) {
  let failed = 0;
  const errors: string[] = [];
  const collect = (tree: KillTree) => {
    const diagnostics = [...tree.errors];
    if (tree.completedCleanupError) {
      diagnostics.push(tree.completedCleanupError);
    }
    if (diagnostics.length > 0) {
      failed += 1;
      for (const error of diagnostics) {
        errors.push(
          tree === unlabeledRoot ? error : `${resolveSubagentLabel(tree.entry)}: ${error}`,
        );
      }
    }
    tree.children.forEach(collect);
  };
  // No authority checks or I/O here: a later sibling can fault an already-visited node.
  // Failures count stable selected nodes, independent of later replacements and killed counts.
  trees.forEach(collect);
  return { errors, failed };
}
