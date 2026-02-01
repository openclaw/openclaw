---
description: Review PRs from URLs with structured issue and code analysis
---

You are given one or more GitHub PR URLs: $@

For each PR URL, do the following in order:

1. Read the PR page in full. Include description, all comments, all commits, and all changed files.
2. Identify any linked issues referenced in the PR body, comments, commit messages, or cross links. Read each issue in full, including all comments.
3. Analyze the PR diff. Read all relevant code files in full with no truncation from the current main branch and compare against the diff. Do not fetch PR file blobs unless a file is missing on main or the diff context is insufficient. Include related code paths that are not in the diff but are required to validate behavior.
4. Check if docs/\*.md require modification. This is usually the case when existing features have been changed, or new features have been added.
5. Provide a structured review with these sections:
   - Good: solid choices or improvements
   - Bad: concrete issues, regressions, missing tests, or risks
   - Ugly: subtle or high impact problems
6. Add Questions or Assumptions if anything is unclear.
7. Add Change summary and Tests.

Output format per PR:
PR: <url>
Good:

- ...
  Bad:
- ...
  Ugly:
- ...
  Questions or Assumptions:
- ...
  Change summary:
- ...
  Tests:
- ...

If no issues are found, say so under Bad and Ugly.
