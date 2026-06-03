import path from "node:path";
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";

/**
 * Primary bootstrap runs are only top-level agent sessions. Subagents and ACP
 * sessions inherit already-established context and should not restart workspace
 * bootstrap onboarding.
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
 * Rewrites hook-injected context file paths from the source workspace to the
 * target attempt workspace. Files outside the source workspace keep their
 * original paths so unrelated absolute references are not silently retargeted.
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
