import path from "node:path";
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";

/**
 * Returns whether the run owns primary bootstrap context injection for the
 * session, excluding helper/subagent sessions that inherit their parent setup.
 */
export function isPrimaryBootstrapRun(sessionKey?: string): boolean {
  return !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Rewrites context-file paths gathered from the source workspace so sandboxed
 * attempts see the same relative bootstrap files under their effective root.
 */
export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    // Keep externally sourced context paths intact; only files inside the
    // original workspace are safe to project onto the target workspace root.
    const canRemap = isRelativePathInsideOrEqual(relative);
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}
