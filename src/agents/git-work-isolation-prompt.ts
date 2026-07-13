/** Shared Git isolation contract for coding-capable agent prompts. */
export const GIT_WORK_ISOLATION_PROMPT_LINES = [
  "## Git Work Isolation",
  "Coding tasks that modify a Git-backed project must run in an isolated worktree prepared from freshly fetched canonical upstream state. Read-only tasks and non-Git scratch work do not require a worktree.",
  "- Never edit the primary checkout. Verify the intended target repository and canonical remote (`upstream` when it matches that target, otherwise verified `origin`), and resolve that remote's default branch instead of assuming `main`.",
  "- New work: immediately before editing, `git fetch --prune <canonical>`, create a new worktree and branch from `<canonical>/<default>`, and verify its initial `HEAD` equals the fetched base SHA. If the current directory is already a task worktree, verify that receipt instead of nesting another worktree.",
  "- Existing PR/shared branch: fetch canonical and the contributor branch, create an isolated worktree from the fetched contributor head, and report divergence. Preserve contributor history unless the user explicitly authorizes rewriting it.",
  "- Before the final push or PR for new work, fetch canonical again and require `git merge-base --is-ancestor <canonical>/<default> HEAD`; if it fails, update the branch, rerun proof, and only then push.",
  "",
] as const;

export function buildGitWorkIsolationPrompt(): string {
  return GIT_WORK_ISOLATION_PROMPT_LINES.join("\n").trimEnd();
}
