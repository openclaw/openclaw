# Release CI: readiness

## Keep FRV off the idle path

Optimize time to the next **passing** FRV; overlap remote validation with repairs/proof. This is scheduling advice, not another gate, checklist, deadline, or demand for certainty. Existing release gates apply.

- **Start promptly:** favor overlapping useful local checks with remote FRV rather than completing all of them first. Uncertainty alone is no reason to idle; supersede through normal recovery if local work finds a defect.
- **Repair as failures arrive:** prioritize known non-flake repairs over optional confidence checks; diagnose them while other lanes drain. Use independent repair lanes when useful; integrate ready fixes without waiting for the final report.
- **Aim to finish repairs by drain completion:** focused proof/review included. If longer, keep repairing—no redundant checks or process filler.
- **Before next FRV:** fix every known non-flake affecting C/Q/P. Do not launch with known failure B after fixing A; no requirement to eliminate unknowns or unrelated issues.
- **Retry strategically:** eligible targeted retries can overlap diagnostics. Use the [budget](recovery.md#run-identity-and-retry-budget) for flakes/repaired external prerequisites; retain valid green proof. Fix deterministic failures rather than repeat them. Start necessary fresh parents without optional delay.

### Optional broad CI discovery alongside initial FRV

Optional diagnosis, **not** a prerequisite, checklist, or release gate:

1. Inspect recent scheduled `CI` and `Plugin Prerelease` failures, SHAs, and coverage. Treat them as diagnostic leads, not verdicts on another candidate; keep unrelated main-only fixes off the critical path.
2. Prefer initial FRV's CI/plugin children when they cover C. For missing coverage or a separate repair revision, consider one full-tier CI/complete-plugin-inventory pass on that revision **alongside**, not before, initial FRV. Let FRV also find package/upgrade/live-provider/non-CI failures. Do not duplicate active children or broad-run after every fix.
3. Let independent diagnostics finish; group failures and prove fixes with affected tests/shards. Feed release-relevant fixes into the next candidate under existing intake/evidence rules. Discovery neither authorizes unrelated changes nor counts as release proof.

## Deferred CI recovery

- Release validation does not pause CI/supporting workflows.
- Current admission ignores legacy `OPENCLAW_RELEASE_PRIORITY_RUN`; `pnpm frv prioritize --run` is retired.
- Recover older deferred runs/clear their variable with `pnpm frv prioritize --restore <record>`. Preserve publication proofs and soak gates.

## Continuous release readiness

- Scheduled main validation: every **3 hours at :07 UTC**; seals a direct-root manifest and per-child receipts for exact main SHA.
- Same-day cut: land version/changelog train on main before the scheduled run; cut `release/YYYY.M.PATCH` at its SHA so Code SHA = validated SHA.
- Child adoption matches exact target, role, and dispatch inputs except `dispatch_id`. Context-free `productPerformance` inputs match and are adopted.
- Stable `--target-ref release/YYYY.M.PATCH` selects `coveragePolicy=npm-stable-v1`, `ci_release_scope=npm-stable`; main uses `full`. `normalCi`, plugin prerelease, and release checks redispatch: `target_context_ref` inputs differ, plugin/release checks add `allow_frozen_target_scenario_omissions=true`, and scope differs.
- Whole-parent adoption needs byte-identical manifest `validationInputs`, including `validationPurpose`, `publicationSelectionJson`, `targetContextRef`, `targetVersion`, `allowUnreleasedChangelog`, and `coveragePolicy`. A `main-qualification` nightly cannot qualify a `publish` stable candidate wholesale. Purpose/context-crossing adoption remains a verifier-policy follow-up.

## Release tooling fast lane

- Add `release-fast-lane` before the triggering push: CI reads event labels; label events do not start CI. Already pushed: `gh pr ready --undo` then `gh pr ready` retriggers with current labels.
- Eligible: canonical PR, all paths in `.github/workflows/**`, `scripts/**`, `test/scripts/**`, `.agents/skills/release-*/**`, `docs/reference/RELEASING.md`, or independently checked docs.
- Keeps `security-fast`, `check-shard` (lint, prod/test types, guards, dependencies, npm lock), changed-docs `check-docs`, and changed Node rows. Planner compact-packing full-plan proof narrows to those rows.
- Skips contracts, baseline ratchets, bundled protocol, Bun launcher, additional checks, build artifacts (unless changed rows need `dist`), Control UI, Windows/macOS/iOS/Android, i18n, and skills. Preflight summary lists skips under "Release fast lane".
- Declined for out-of-scope/global-Node inputs, forks, push/dispatch, or docs-only: warn and retain ordinary selection. Every selected lane must pass; hourly full main CI covers merged results.
- Label changes only CI selection. [Native maintainer workflow](../../openclaw-pr-maintainer/references/landing.md) still owns review/landing; fork heads are declined.
