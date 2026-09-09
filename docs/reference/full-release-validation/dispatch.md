---
doc-schema-version: 1
summary: "Dispatching Full Release Validation: Code SHA and Tooling SHA selection, helper inputs, and the immutable execution plan"
title: "Dispatch a validation run"
read_when:
  - Starting a Full Release Validation run
  - Selecting the Code SHA, Release SHA, and Tooling SHA
---

`Full Release Validation` is the release product-validation umbrella. Most work
happens in child workflows so a failed box can be rerun without restarting the
whole release. Run release preparation before freezing the Code SHA; it
refreshes Control UI locale output when the background bot has not landed it
yet, then enforces the same strict zero-fallback check used by release CI.

Linux (`ubuntu`) cross-OS fresh-install and upgrade lanes gate publication in
the beta, stable, and full profiles. Windows and macOS cross-OS lanes run in
parallel as **advisory** coverage: their pass/fail conclusions remain in the
manifest and summary, but failures do not block Release Decision, npm publish,
or `pnpm release:candidate`. Selected lanes still need terminal evidence.
Normal CI, npm qualification, Docker, Package Acceptance, and the profile's
performance and soak requirements keep their existing gates.

Prepare the complete history manifest and substantive version-matched release
notes before freezing the product-complete commit and its target context as the
**Code SHA/ref**. Package source preflight requires a matching release section;
an empty placeholder is not preparation. If the notes are final, this commit
can also be the **Release SHA**. Select one trusted workflow commit and context
as the **Tooling SHA/ref**, then run:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

Record the candidate SHA/ref and Tooling SHA/ref once for the release and reuse
them for later Code-SHA, Release-SHA, and focused reruns. Main lineage
authorizes the initial Tooling SHA selection; it does not authorize refreshing
the tooling from moving `main`.

`provider` also accepts `anthropic` or `minimax` for cross-OS onboarding and the
end-to-end agent turn. Regular `release/*` targets accept the branch's final
package version or a matching beta prerelease. For a correction, use
`--target-ref release/YYYY.M.PATCH-N` to preserve the intended final tag before
tagging. Its base package version is also accepted when `vYYYY.M.PATCH` resolves
to the exact Code SHA; preparation retains the package version and seals both
npm and Docker artifacts for `vYYYY.M.PATCH-N`. Tideclaw alpha validation uses
its exact alpha tag and matching alpha branch. The helper maps beta releases and
exact alpha tags to the `beta` profile and final versions to `stable`. Pass
alternate workflow inputs with `-f key=value`; use `-f release_profile=full`
only for the broad advisory sweep.
`fail_fast` defaults to `false`, so dispatched child workflows finish and expose
independent failures together. In that mode, the parent makes no child
cancellation calls. Pass `-f fail_fast=true` only when the shorter
first-failure path is preferable; Release Decision then cancels only the exact
still-active child that owns the blocking failure.
Same-parent continuation requires the original root to have been dispatched
with `fail_fast=false`. The controller verifies that exact logged input before
any rerun mutation.
Current runs dispatch standalone `Full Release Artifacts` producers for npm,
Docker, and the validation candidate. Each producer owns its immutable dispatch
record and output receipt. Parent retries recover those exact producer IDs and
attempts, recheck their source and Tooling SHAs, and reuse the successful builds.
Historical parents that produced their own candidate or publication artifacts
cannot continue: keep both SHAs frozen and start a fresh all-group validation.

After dispatch, the parent writes one immutable
`full-release-execution-plan-<run-id>` artifact and preserves the same bytes in
an exact run-ID Actions cache. It records selected and
required coverage, gate results, reuse identity, the original parent attempt,
the fresh candidate request plus producer and publisher evidence when preparation ran, and
every exact child run ID, attempt, title, workflow ref, and Tooling SHA.
Decision, Drain, manifest generation, evidence verification, and the final
verifier consume the artifact for their current attempt. Collector retries
use the exact run-ID cache as an acceleration. If that cache is unavailable,
they restore the same immutable plan from the parent-run artifact, validate it,
and upload the artifact again for the retry; they never rebuild the plan or
redispatch tests. A missing or invalid artifact fails closed, so start a new
validation instead of retrying that stale parent.
Release Decision also repeats canonical reuse-chain validation before a reused
run can pass. The sealed target SHA, evidence SHA, policy, changed-path set,
selected run, root run, source manifest, trusted tooling identity, and child
tuple must all still match.

On a parent retry, final verification selects the newest available Release
Decision and Diagnostic Drain artifacts independently. Both must bind the same
immutable plan and exact child tuple; their source attempts remain recorded in
the artifacts and may differ when only one collector needed a retry.
