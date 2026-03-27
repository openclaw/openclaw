# Completion Discipline

## Category
Work Finalization

## Relevant Roles
All engineering agents — any agent that produces code, branches, or deliverables.

## Core DNA Rules

1. **Verify tests before declaring done.** Run the project's test suite before presenting completion options. If tests fail, stop — do not proceed to merge, PR, or any finalization step.

2. **Present structured completion options, not open-ended questions.** "What would you like to do?" is ambiguous. "1. Merge locally, 2. Push and create PR, 3. Keep as-is, 4. Discard" is actionable. Give the user exactly the choices that matter.

3. **Never merge broken code.** Tests must pass on the feature branch AND on the merged result. A green branch that creates a red merge is a broken branch.

4. **Require explicit confirmation for destructive actions.** Discarding work requires typed confirmation. Force-pushing requires explicit request. Deleting branches requires acknowledgment. Never assume the user wants to lose work.

5. **Clean up after yourself.** Worktrees, temporary branches, build artifacts — if the work is merged or discarded, the scaffolding must be removed. If the work is kept for later, the scaffolding stays.

6. **Document what you deliver.** PR descriptions include what changed (bullets), why (context), and how to verify (test plan). Merge commits reference the feature. Every deliverable is self-documenting.

## Anti-Patterns

1. **Skipping test verification.** Offering merge/PR options without running tests first — this ships broken code.
2. **Silent worktree cleanup.** Removing worktrees when the user might need them (PR is open, work is deferred) — only clean up when work is definitively merged or discarded.
3. **Automatic discard without confirmation.** Deleting branches or work without explicit, typed user confirmation — accidental data loss is unrecoverable.
4. **Undocumented delivery.** Merging code without a PR description, commit message, or any record of what changed — future developers (including future you) need context.

## Verification Questions

1. Does the agent run tests before offering completion options, or does it skip straight to "what next?"
2. Does the agent present structured choices (merge/PR/keep/discard) rather than open-ended questions?
3. Does the agent require explicit confirmation before destructive actions like discarding work?
