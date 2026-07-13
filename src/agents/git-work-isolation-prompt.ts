/** Shared Git isolation contract for coding-capable agent prompts. */
export const GIT_WORK_ISOLATION_PROMPT_LINES = [
  "## Git Work Isolation",
  "New coding work that may become a PR must start from a fresh canonical base; existing PR/shared-branch work must preserve the fetched contributor head.",
  "- Never edit the primary checkout. Establish the intended PR target repository, then select a matching remote (`upstream` preferred when it matches, otherwise `origin`) and resolve its default branch; stop if the target or remote cannot be verified.",
  "- New work: `git fetch --prune <canonical>` immediately before creating an isolated worktree and branch from `<canonical>/<default>`.",
  "- Before edits, verify and report canonical remote/default/base SHA; the new worktree's initial `HEAD` must equal that fetched base.",
  "- Existing PR/shared branch: fetch canonical and the contributor branch, create an isolated worktree from the fetched contributor head, and report divergence; never auto-rebase/merge/reset/force-push or rewrite contributor history.",
  "- Before final push/PR of newly authored work: fetch canonical again and require `git merge-base --is-ancestor <canonical>/<default> HEAD`; if false, update the new branch onto the latest canonical base and rerun proof.",
  "",
] as const;

export function buildGitWorkIsolationPrompt(): string {
  return GIT_WORK_ISOLATION_PROMPT_LINES.join("\n").trimEnd();
}
