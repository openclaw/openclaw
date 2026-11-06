# Trace a fix into a release

Use for “is this fixed?”, “which version contains it?”, and candidate inclusion
checks. This is read-only investigation, not backport or publication authority.
For selecting changes, use [backport discovery](backport-discovery.md); for
published artifacts, use the relevant checks in `$verify-release`.

## Pin the evidence boundary

1. Decide whether the request concerns current remote state or a frozen snapshot.
   For current state, refresh the relevant remote branches and tags, then record
   their exact SHAs. For a frozen or explicit no-fetch audit, retain the supplied
   endpoint SHAs and use `GIT_NO_LAZY_FETCH=1` for local Git reads. Missing objects
   block that part of the audit; do not silently fetch or substitute moving refs.
2. Identify the canonical fix commit or complete dependent group from the merged
   PR and source history. A matching error message or PR title is a discovery
   clue, not proof that two reports have the same cause. Direct commits need no
   PR. Keep separate repairs distinct even when one commit carries several.
3. Resolve the shipped baseline, candidate, main, and relevant release branches
   to exact SHAs. Record which endpoints were checked; a branch tip does not
   prove what an earlier validation run or published artifact contained.

## Prove inclusion, not just a matching SHA

Start with `git merge-base --is-ancestor <fix-sha> <target-sha>`. Distinguish
exit 1 (not an ancestor) from an error or unavailable object. Ancestry is a lead,
not proof that a later revert or modification preserved the repair.

When ancestry is absent, check patch equivalence with `git cherry` and inspect
the target's affected code, companions, and regression tests. Adapted or squashed
backports can contain the repair without the original SHA. Conversely, a related
commit or passing unrelated test does not establish the fix. For mixed commits,
compare `git show <source-sha> -- <affected-paths>` with the destination repair
scope; do not assign every bundled fix to a narrow existing hotfix record.

For release discovery, `git tag --contains <fix-sha> --sort=v:refname` finds
ancestry candidates, not every adapted backport. Check tags containing verified
destination commits too. Separate beta, stable, and extended-stable histories;
version sorting across tracks does not establish the first published fix. Verify
the relevant tag's actual repair and publication evidence before naming a released
version. If the earliest version was not established, say “verified in” rather
than “first fixed in.”

Record source identity, target SHA, destination commits or equivalent code,
relevant proof, and uncertainty in the existing release evidence and
[hotfix assessments](hotfix-ledger-management.md). Integration evidence and
runtime qualification are separate claims.

## Count cumulative upstream fixes

When asked for a release-wide total, extend the existing backport inventory with
`batch`, optional `pr`, `source`, and `carrier` columns. The source is the original
upstream commit; the carrier is its actual destination commit in the candidate.
Multiple source commits may share an aggregate carrier. Deduplicate by source,
not PR, batch, carrier, or release-branch commit count.

Verify each counted source belongs to the frozen upstream endpoint and is not
already included or equivalent in the shipped baseline; verify its repair scope
and carrier in the candidate as above. Label partial adaptations explicitly.
Exclude release-only tooling repairs from upstream product-fix totals. Report
the verified cumulative source count separately from the latest batch size,
branch commit count, and unresolved entries. This count is not a count of distinct
user-visible defects.

## Report the smallest supported conclusion

For each repair, report one of: verified in a published version, included in the
exact candidate but not verified published, merged on main only, not found in
the checked release target, or blocked by missing evidence. Include the checked
refs/SHAs, publication evidence when applicable, and any qualification gap.
