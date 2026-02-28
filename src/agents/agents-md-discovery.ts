import fs from "node:fs/promises";
import path from "node:path";

const AGENTS_MD_FILENAME = "AGENTS.md";

export type AgentsMdEntry = {
  dir: string;
  content: string;
};

/**
 * Walk from a file's parent directory upward toward the filesystem root,
 * collecting AGENTS.md files found along the way. Skips the workspace root
 * directory (its AGENTS.md is already injected into the system prompt) and
 * any directory already recorded in `seenDirs`.
 *
 * Returns entries sorted root-to-leaf (outermost first).
 */
export async function discoverAgentsMd(
  filePath: string,
  workspaceRoot: string,
  seenDirs: Set<string>,
): Promise<AgentsMdEntry[]> {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const fileDir = path.dirname(path.resolve(filePath));

  // Collect ancestor directories from fileDir upward (leaf first).
  const dirs: string[] = [];
  let current = fileDir;
  for (let depth = 0; depth < 64; depth++) {
    if (current === resolvedWorkspace) {
      // Skip workspace root — already in system prompt.
      break;
    }
    if (!seenDirs.has(current)) {
      dirs.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root.
      break;
    }
    current = parent;
  }

  // Reverse so we check root-to-leaf (outermost first).
  dirs.reverse();

  const entries: AgentsMdEntry[] = [];
  for (const dir of dirs) {
    seenDirs.add(dir);
    const agentsPath = path.join(dir, AGENTS_MD_FILENAME);
    try {
      const content = await fs.readFile(agentsPath, "utf-8");
      if (content.trim()) {
        entries.push({ dir, content });
      }
    } catch {
      // No AGENTS.md in this directory — skip.
    }
  }

  return entries;
}

/**
 * Format discovered AGENTS.md entries as a text block to prepend to a read result.
 */
export function formatAgentsMdPreamble(entries: AgentsMdEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(
      (entry) => `--- AGENTS.md (from ${entry.dir}/) ---\n${entry.content}\n--- end AGENTS.md ---`,
    )
    .join("\n\n");
}
