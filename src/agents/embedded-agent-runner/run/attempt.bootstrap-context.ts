import path from "node:path";
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";

/**
 * Only top-level user sessions own primary workspace bootstrap injection.
 * Subagents and ACP sessions receive context through their parent/session
 * routing, so injecting primary bootstrap files there would duplicate context.
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
 * Rebase injected context-file paths from the real workspace to the effective
 * attempt workspace while leaving out-of-workspace files untouched.
 *
 * This keeps sandboxed file references pointing at the copy the model can read,
 * without rewriting external absolute paths that were intentionally attached.
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
    // Only remap paths that remain inside the source workspace; external
    // context files keep their absolute path instead of being pulled into the sandbox.
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
