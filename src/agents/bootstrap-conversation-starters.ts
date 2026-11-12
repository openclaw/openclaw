import path from "node:path";
import { parseFrontmatterBlockResult } from "../../packages/markdown-core/src/frontmatter.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "./workspace-bootstrap-policy.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";

type Entry = {
  starters?: string[];
  pending?: Promise<string[] | undefined>;
  dirty: boolean;
  watch: ReturnType<typeof observeOwnedDirectory>;
};

const entries = resolveGlobalMap<string, Entry>(
  Symbol.for("openclaw.bootstrapConversationStarters"),
  (cache) => {
    for (const entry of cache.values()) {
      entry.watch.close();
    }
    cache.clear();
  },
);

async function readStarters(workspaceDir: string): Promise<string[] | undefined> {
  try {
    const file = await readWorkspaceFileWithGuards({
      workspaceDir,
      filePath: path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME),
    });
    if (!file.ok) {
      return undefined;
    }
    const { frontmatter, issues } = parseFrontmatterBlockResult(file.content);
    if (issues.length || !frontmatter.conversationStarters) {
      return undefined;
    }
    const value: unknown = JSON.parse(frontmatter.conversationStarters);
    if (
      !Array.isArray(value) ||
      !value.length ||
      !value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
    ) {
      return undefined;
    }
    return value.map((item) => item.trim());
  } catch {
    // Optional presentation metadata must not prevent selecting an agent.
    return undefined;
  }
}

/** Gateway file-editor writes invalidate before acknowledging the save. */
export function invalidateBootstrapConversationStarters(workspaceDir: string): void {
  const entry = entries.get(path.resolve(workspaceDir));
  if (entry) {
    entry.dirty = true;
  }
}

/** Read once; workspace notifications refresh edits, removal, and later recreation. */
export async function loadBootstrapConversationStarters(
  workspaceDir: string,
): Promise<string[] | undefined> {
  const key = path.resolve(workspaceDir);
  // A hosted workspace has its own file authority, not a Gateway-local watch.
  try {
    if (getAgentWorkspaceAccess(key)) {
      return await readStarters(key);
    }
  } catch {
    return undefined;
  }
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= 64) {
      const oldest = [...entries].find(([, candidate]) => !candidate.pending);
      if (!oldest) {
        return readStarters(key);
      }
      oldest[1].watch.close();
      entries.delete(oldest[0]);
    }
    const watch = observeOwnedDirectory(key, (filename) => {
      if (!filename || filename === DEFAULT_BOOTSTRAP_FILENAME) {
        invalidateBootstrapConversationStarters(key);
      }
    });
    entry = { dirty: true, watch };
    entries.set(key, entry);
  }
  if (!entry.pending && entry.dirty) {
    entry.dirty = false;
    const selected = entry;
    entry.pending = readStarters(key)
      .then((starters) => (selected.starters = starters))
      .finally(() => {
        selected.pending = undefined;
      });
  }
  return entry.pending ?? entry.starters;
}
