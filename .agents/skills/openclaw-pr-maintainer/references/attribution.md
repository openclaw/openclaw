# Author and regression attribution

- Read for authorship question, contributor identity/history needed for concrete trust decision, or regression attribution. Ordinary review: contributor identity + credit, no history investigation.

## Contributor context

- Verified PR/issue author login, not chat user's name. Useful profile metadata: fetch once.

```bash
gh api users/<login> --jq '{login,name,created_at,type}'
.agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh <login>
```

- `--global` only for relevant GitHub-wide activity; up to five calls/person when enabled, never every item by default. Native caching; separate repo totals from contribution-graph totals + actual intervals. Missing/incomplete/cached/failed queries ≠ zero; private visibility affects totals. Activity ≠ patch correctness evidence.
- Credit: public author email from PR commit or GitHub noreply. Never invent name/email.

## Introducing-commit claims

- `git log -S/-G`, blame, linked PRs find candidates, not introduction proof. Inspect raw parents + implicated behavior:

```bash
git --no-replace-objects cat-file -p <candidate-sha>
git --no-replace-objects diff --no-ext-diff --no-textconv \
  <raw-parent> <candidate-sha> -- <path>
```

- A shallow/grafted boundary ≠ root commit. Missing parents/unverifiable patch → unknown, never invented introducing SHA. Use before/after behavior proof when feasible. Unknown history doesn't invalidate proven current defect.
- Separate code author, PR author, merger, committer, automation trigger, current PR owner. Human automation attribution only from verified timeline/command evidence. Report confidence + narrow supported claim; dates, roles, maintainer involvement ≠ introduction.
