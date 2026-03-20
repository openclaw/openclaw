# Reporting and Watch Mode Reference

Read this file when formatting result summaries or running the watch loop.

## Results Collection Output

Present a summary table like:

```text
| Issue                 | Status    | PR                             | Notes                          |
| --------------------- | --------- | ------------------------------ | ------------------------------ |
| #42 Fix null pointer  | PR opened | https://github.com/.../pull/99 | 3 files changed                |
| #37 Add retry logic   | Failed    | --                             | Could not identify target code |
| #15 Update docs       | Timed out | --                             | Too complex for auto-fix       |
| #8 Fix race condition | Skipped   | --                             | PR already exists              |
```

Status values:

- `PR opened` — success, link to PR
- `Failed` — sub-agent could not complete
- `Timed out` — exceeded 60 minutes
- `Skipped` — existing PR detected in pre-flight

If `--notify-channel` is set, send the final summary with only successfully opened PRs:

```text
✅ GitHub Issues Processed

Processed {N} issues: {success} PRs opened, {failed} failed, {skipped} skipped.

{PR_LIST}
```

Where `PR_LIST` uses:

```text
• #{issue_number}: {PR_url} ({notes})
```

## Review Results Output

After review sub-agents complete, present a summary table like:

```text
| PR | Comments Addressed | Comments Skipped | Commit | Status |
|----|-------------------|-----------------|--------|--------|
| #99 fix/issue-42 | 3 | 0 | abc123f | All addressed |
| #101 fix/issue-37 | 1 | 1 | def456a | 1 needs manual review |
```

## Watch Mode State

Between poll cycles, retain only:

- `PROCESSED_ISSUES`
- `ADDRESSED_COMMENTS`
- `OPEN_PRS`
- Cumulative results
- Parsed arguments
- `BASE_BRANCH`, `SOURCE_REPO`, `PUSH_REPO`, `FORK_MODE`, `BOT_USERNAME`

Do not retain issue bodies, comment bodies, sub-agent transcripts, or codebase analysis between polls.
