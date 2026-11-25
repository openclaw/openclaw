# Trace a fix into a release

Use for “is this fixed?” and “which version contains it?” For release-wide
selection and pinned audit bounds, use [backport discovery](backport-discovery.md).
This investigation does not authorize a backport or publication.

## Verify the repair

- Identify the actual fix and any required companion changes, not just a matching
  PR title or error message. Record the source and checked target SHAs.
- Check ancestry with `git merge-base --is-ancestor <fix> <target>`. Absence does
  not rule out an adapted or squashed backport: use patch comparison and inspect
  the target code and relevant tests. Presence does not rule out a later revert.
- For a commit carrying several repairs, verify the requested repair separately;
  a partial backport does not establish inclusion of everything in that commit.

## Identify a published version

`git tag --contains <fix>` finds ancestry candidates. Include tags containing a
verified backport commit, and check the repair in the relevant release line.
A branch tip or tag alone does not prove what was published; use the relevant
artifact checks in `$verify-release`. Version ordering across beta, stable, and
extended-stable tracks does not establish publication order.

Report “verified in” unless the earliest published version was established.
Distinguish published, candidate-only, main-only, and unverified status. Record
the conclusion and gaps in the existing release evidence and
[hotfix assessments](hotfix-ledger-management.md). Code inclusion and runtime
qualification remain separate claims.

## Count cumulative upstream fixes

Use the existing backport inventory to map original upstream commits to their
candidate commits; several source commits may share one aggregate backport.
Count each verified source once, excluding repairs already present in the shipped
baseline and release-only tooling. Label partial or unresolved entries separately.
A cumulative source-commit count is neither the latest batch size nor a count of
distinct user-visible defects.
