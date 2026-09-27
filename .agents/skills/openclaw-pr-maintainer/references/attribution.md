# Author and regression attribution

Read this when the user asks who wrote something, when contributor identity or
history matters to a concrete trust decision, or when assigning a regression to
an introducing commit. Ordinary review needs contributor identity and preserved
credit, not a contribution-history investigation.

## Contributor context

For author research, use the verified PR/issue author login, not a chat display
name. An automation account publishing a PR is not its human contributor. Fetch
profile metadata once if useful:

```bash
gh api users/<login> --jq '{login,name,created_at,type}'
.agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh <login>
```

Add `--global` only when GitHub-wide activity is relevant. The helper uses up to
five calls per person with global activity enabled; do not run it for every item
by default. Use native caching and separate repository totals from contribution
graph totals with their actual intervals. Missing, incomplete, cached, or failed
queries are not zero activity; private visibility may affect totals. Activity is
context, not evidence that a patch is correct or incorrect.

Use a public author email from the PR commit, or its GitHub noreply identity,
when preserving real contributor credit. Never invent a name or email.

## Credit for agent-assisted work

Resolve human credit from the task's verified request and contribution provenance,
using the canonical attribution owner and current consent. A session-wide roster,
session owner, PR publisher, merge actor, display name, or copied memory is not
proof that a person contributed to this task. Preserve valid inherited authors
without treating an unrelated base commit's authors as task contributors.

Across delegation and continuations, retain the original evidence and distinguish
human input from agent-generated instructions. Do not relabel an agent's copied
credit list as a new human request or use it to resolve a conflicting identity.
Credit does not grant permissions or assign session ownership. Honor incognito,
current credit preferences, and explicit task-specific exclusions; do not backfill
historical credit from today's parent roster.

Keep prose acknowledgments before one terminal trailer block. Verify the final
composed message with Git's trailer parser, not a substring search:

```bash
git show -s --format=%B <commit-sha> | git interpret-trailers --no-divider --parse
```

Check the actual published commit's GitHub-recognized author/coauthor identities
against the verified eligible contributors. A human primary author does not need
a self-coauthor trailer. Check publisher-generated commits separately: a credited
implementation does not establish that a later publication commit retained it.
When landing is authorized, inspect the native workflow's composed squash message
and verify the landed commit rather than assuming source trailers survived.

Report the surface actually verified: PR acknowledgment, source commit,
publication commit, or landed commit. Editing a merged PR's body does not repair
its commit metadata; do not rewrite shared history without explicit authority.
If the human disputes recorded sender identity, state that discrepancy and
investigate its producer instead of asserting that the stored profile proves who
personally sent the request. Do not blame GitHub for a substitution without
checking the submitted message and resulting metadata.

## Introducing-commit claims

`git log -S/-G`, blame, and linked PRs find candidates; they do not prove who
introduced the defect. Inspect raw parents and compare the implicated behavior:

```bash
git --no-replace-objects cat-file -p <candidate-sha>
git --no-replace-objects diff --no-ext-diff --no-textconv \
  <raw-parent> <candidate-sha> -- <path>
```

A shallow/grafted boundary is not a root commit. Missing parent objects or an
unverifiable patch means unknown attribution, not an invented introducing SHA.
Use before/after behavior proof when feasible. Unknown history does not invalidate
an independently demonstrated current defect.

Distinguish code author, PR author, merger, committer, automation trigger, and
current PR owner. Attribute automation to a human only from verified timeline or
command evidence. Report confidence and the narrow claim the evidence supports;
do not infer introduction from dates, roles, or a maintainer's involvement.
