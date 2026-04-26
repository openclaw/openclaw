import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AcpWorktreeDiffResult = {
  hasChanges: boolean;
  stat: string;
};

/**
 * Verify that an ACP worktree has actual file changes relative to HEAD.
 *
 * Fail closed: any error (missing cwd, git failure, timeout) returns
 * hasChanges=false so the caller can decide how to treat the run.
 */
export async function verifyAcpWorktreeDiff(cwd: string): Promise<AcpWorktreeDiffResult> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    const stat = stdout.trim();
    return {
      hasChanges: stat.length > 0,
      stat,
    };
  } catch {
    return {
      hasChanges: false,
      stat: "",
    };
  }
}
