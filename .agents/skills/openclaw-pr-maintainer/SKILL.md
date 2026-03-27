---
name: openclaw-pr-maintainer
description: Maintainer workflow for reviewing, triaging, preparing, closing, or landing OpenClaw pull requests and related issues.
---

# OpenClaw PR Maintainer

Use this skill for maintainer-facing GitHub workflow, not for ordinary code changes.

## Follow PR review and landing hygiene

- Expect `checks-fast-handoff-freshness` to run and pass on PRs that touch handoff memory or session rollover surfaces before landing them.
- When landing or merging any PR, follow the global `/landpr` process.
- Use `scripts/committer "<msg>" <file...>` for scoped commits instead of manual `git add` and `git commit`.
- Keep commit messages concise and action-oriented.
- Group related changes; avoid bundling unrelated refactors.
- Use `.github/pull_request_template.md` for PR submissions and `.github/ISSUE_TEMPLATE/` for issues.
