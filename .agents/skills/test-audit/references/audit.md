# Audit workflow

- Use after [authoring gate](../SKILL.md#authoring-gate).
- Whole-subsystem campaigns: also require [CAMPAIGN.md](../CAMPAIGN.md).

## Junk patterns

Reject new matches unless [retention bar](#retention-bar) identifies independent
contract. Audit existing matches:

- Assertion-free probes, self-comparisons, identity copiers, subject-generated
  expected values.
- Copied inventories/manifests/export lists; exact source/import/string greps.
- Private predicate/call-shape tests duplicating boundary proof; repeated
  invocations/provider-local replays of shared helpers.
- Test-only exports/globals/wrappers; production paths called only by tests.
- Mocks implementing asserted behavior or pretending distinct APIs match.
- Fixtures supplying receipts, admission, callback ordering owner should produce;
  persistence asserted against store path never writes.
- Capability flags asserted instead of promised delivery/acknowledgement.
- Negative controls passing on unrelated guard or unreachable rejection.
- Names promising behavior inputs/assertions never exercise.

## Retention bar

- Keep independent public API, SDK, protocol, config, migration, storage,
  security, platform, default, prompt-byte, generated cross-language, package,
  release, architecture contracts. Keep observable ordering + credible regressions.
- Source inspection valid when cheapest independent guard of user-facing key,
  byte, path, and survives identifier-only refactoring.
- Static/slow ≠ deletion reason. Baseline failure may be product bug:
  reproduce + repair owner; never delete test for it.

## Candidate evidence

- Before editing: read full test, production owner, entry point, callers,
  callees, siblings, overlapping proof, CI routing, history. Dependency-backed
  claims: inspect dependency source/types. Read root/scoped instructions.
- Record each candidate's:
  - Exact name/location + detectable failure.
  - Non-test callers of covered production/support seam.
  - Stronger remaining owner proof, or why none needed.
  - History/reason it exists + deletion it unlocks.
  - Risk + focused validation command.
- Missing evidence: no deletion. Discovery read-only; report before edits.
  Prefer few high-confidence candidates. Parallel discovery may split independent
  owners.
- Delete obsolete seams/dead paths; move retained regressions to owner;
  consolidate generic package/dependency contracts.
- Prefer net-negative production LOC. Never add replacement implementation tests
  or turn uncertainty into cleanup.

## Validation and handoff

- Follow [proof policy](../../openclaw-testing/SKILL.md#proof-policy).
  Never edit checkout during active Vitest run. Run owner/sibling tests.
- Removed source greps/plan assertions: exercise owning executable/dry-run.
- Run targeted format, `git diff --check`; classify changed gate with
  `node scripts/check-changed.mjs --dry-run -- <changed-paths>` before running it.
- Inspect `git diff --numstat`; get final autoreview.
- Report causes, removed categories/seams, retained false positives, proof/cost,
  production versus test/support LOC, PR state, follow-ups.
- Commit/push/land only when authorized through native maintainer workflow.
  Refresh from main + rediscover before another audit batch.
