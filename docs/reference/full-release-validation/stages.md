---
doc-schema-version: 1
summary: "The Full Release Validation umbrella stage matrix, evidence reuse, artifact producers, and decision states"
title: "Top-level stages"
read_when:
  - Reading the umbrella stage matrix
  - Debugging a Release Decision or Diagnostic Drain state
---

## Top-level stages

For `rerun_group=all`, a `Check for reusable validation evidence` job runs
first. It looks for the newest prior green full validation with the same release
profile, coverage policy, effective soak setting, and validation inputs. Exact-target reruns use
`exact-target-full-validation-v1`. A descendant whose complete delta is exactly
`CHANGELOG.md` uses `changelog-only-release-v1`; every product lane is skipped
and the verifier independently rechecks the GitHub commit comparison, immutable
parent artifact, child runs, and dispatch logs. Any other target change requires
a fresh Code SHA validation. Pass `reuse_evidence=false` to force a fresh full
run. Evidence reuse runs only from `main` or a canonical SHA-pinned
`release-ci/*` ref whose workflow commit remains on trusted `main` lineage;
other workflow refs run the selected lanes fresh.

The reuse search checks each bound parent manifest for eligibility before
loading its child runs, job logs, and execution plan. Incompatible profiles,
inputs, targets, and non-root runs are rejected early. Eligible candidates
still undergo complete provenance and attempt verification before reuse.
The verifier reads independent children concurrently (at most seven), retains
each attempt's job data for its policy checks, and waits for all reads before
reporting success or failure. Attempts and pagination within each child remain
sequential. Target resolution and reuse checkouts include only their tooling
and release metadata; neither needs the complete source tree.

Full validation starts independent npm and Docker producer runs through
`full-release-artifacts.yml`. The read-only `openclaw-npm-preflight.yml` starts
source, SDK, dependency, and package preparation together. Package-content and
lifecycle checks start when the single root/core build and pack finishes. The
early `openclaw-npm-package-descriptor-<run-id>-<attempt>` artifact also unblocks
candidate preparation while qualification continues. Final qualification joins
every successful exact-source proof and seals the same tarball bytes.
The SDK consumer install retains its smaller dependency context. The final manifest records its immutable descriptor in
`publicationArtifacts.npmPreflight`. Regular final releases include separate
SDK compatibility reports for the current npm `beta` and `latest` predecessors,
sharing the target snapshot. Publication selects its channel's report and
acknowledgement without rebuilding. Alpha, beta prerelease, and extended-stable
targets keep their required channel.

For directly dispatched `OpenClaw NPM Release` preflight-only runs, if qualification
fails after source checks and package preparation succeed, rerun the failed
qualification job. It reuses the exact successful producer jobs
and package bytes from the earlier attempt, even if that attempt failed or was
cancelled. Failed or unfinished producer jobs remain ineligible. Final npm
publication still requires the qualified preflight attempt to complete
successfully. FRV-owned standalone producers require fresh all-group validation
after producer failure or an attempt change.

`docker-release-prepare.yml` builds both native architectures, retains OCI
indexes and their SBOM/provenance, and runs image smoke checks before approval.
OCI export uses gzip level 1 for new layers and reuses cached layers without
forced recompression, preserving the image format used by smoke and promotion.

Default and browser images share the builder's local cache. Preparation does not
transfer a remote build cache: fresh provenance timestamps invalidate application
layers, and measured transfers cost more than reusing runtime setup saves.
Fresh runners rebuild that setup, including mutable Debian and npm updates;
the sealed OCI artifacts remain the reusable inputs for publication.
The hosted VM reclaims its local builder when the job ends, so builder-volume
deletion does not delay sealing after the artifact uploads.
The final manifest records `publicationArtifacts.docker`. Preparation has no
publication secrets or registry-write permission. After approval, `Docker
Release` verifies the source/tag, producer, artifact hashes, and image digests,
then promotes those bytes to GHCR and Docker Hub. The publication lock covers
registry writes and selector promotion. Historical evidence without prepared
images uses the same preparation workflow before promotion. Alpha targets
retain their existing npm-only preparation contract.

If Docker preparation succeeds but publication fails in the same workflow run,
rerun the failed publication job. The new publisher attempt verifies the original
successful preparation job and sealed artifacts without rebuilding. A separate
publisher run still requires the original producer attempt to be active or
successful; it cannot adopt a failed producer attempt through this retry path.

Fresh package-facing validation passes the prepared root/core bundle to a
standalone candidate producer that calls `Full Release Candidate`. Its registry carries the exact
unpublished core dependencies and selected plugins. Installers start that
registry before resolving the root package, including npm, pnpm, Bun, and
cross-OS lanes. Published baseline versions remain available through the
upstream registry. Plugin Prerelease and OpenClaw Release Checks each dispatch an
independent phase immediately, while their candidate phases wait for acquisition.
Both candidate phases verify the same package SHA, artifact IDs, service digests,
producer run attempt, and Docker archive digest before use. The package-independent
bare Docker layer uses a content-addressed GHCR cache; candidate-specific images
remain immutable GitHub artifacts. Focused runs with an explicit published
package spec keep the existing package path instead.

Preparation also emits a canonical request digest and a seven-day
`full-release-candidate-v2-<request-sha256>` evidence artifact. Its bounded
manifest binds the exact target and Tooling SHAs, release and soak policy,
effective survivor baselines and scenarios, preparation-plan digest, sorted
plugin package set, producer and publisher workflow/job/run identities, and
package, registry, and image artifact identities and expiry timestamps. The
execution plan seals that evidence. Before preparing a candidate, the umbrella may reuse
the newest artifact with at least fourteen hours of remaining lifetime for the
same canonical request and exact prepared npm tarball digest only after it revalidates the exact workflow run,
publisher job identity, archive digest, manifest, producer attempt and job, and
live metadata for every package, registry, and image artifact.
A proven absence creates a fresh candidate. Bounded lookup uncertainty and
failures after selection are blocking so the run cannot silently switch
candidates. A different prepared tarball requires a fresh candidate even when
the source SHA is unchanged. Full validation succeeds only after package
qualification and Docker preparation also succeed; a passing product Release
Decision alone does not authorize publication.

For alpha targets with `rerun_group=all`, a `Verify Docker runtime image assets`
job builds the `runtime-assets` Docker target with
`OPENCLAW_EXTENSIONS=diagnostics-otel,codex`. It runs in parallel with the other
stages and remains enforced by the umbrella verifier. Other release types
validate that same target inside mandatory Docker image preparation on both
native architectures, avoiding a duplicate build. A narrower `rerun_group`
skips the standalone preflight.

| Stage                   | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution       | **Job:** `Resolve target ref`<br />**Child workflow:** none<br />**Proves:** resolves the release branch, tag, or full commit SHA and records selected inputs.<br />**Rerun:** rerun the umbrella if this fails.                                                                                                                                                                                                                                                                                                                         |
| Publication preparation | **Jobs:** `Prepare release npm artifacts`, `Qualify release npm artifacts`, and `Prepare release Docker artifacts`<br />**Child workflow:** separate npm and Docker `Full Release Artifacts` runs<br />**Proves:** qualifies the exact root/core npm tarballs and both native Docker architectures before publication. Parent retries recover the original producer records and receipts.<br />**Rerun:** continue failed validation children when preparation succeeded; failed or unavailable preparation requires a fresh validation. |
| Shared candidate        | **Job:** `Acquire full release candidate`<br />**Child workflow:** `Full Release Artifacts` calls `Full Release Candidate`, which reuses a trusted candidate or prepares one on a proven miss<br />**Proves:** validates the exact npm tarball, registry, functional image, and producer/publisher binding. Preparation starts after raw npm bytes are ready, before qualification finishes.<br />**Rerun:** rerun the affected package, plugin-prerelease, cross-OS, or live/E2E group using the same candidate.                        |
| Docker assets preflight | **Job:** `Verify Docker runtime image assets`<br />**Child workflow:** none<br />**Proves:** for alpha targets, the `runtime-assets` Docker build target succeeds in parallel with other stages and remains enforced by the umbrella verifier. Runs only for `rerun_group=all`; other release types cover this target in mandatory Docker image preparation.<br />**Rerun:** rerun the umbrella with `rerun_group=all`.                                                                                                                  |
| Vitest and normal CI    | **Job:** `Run normal full CI`<br />**Child workflow:** `CI`<br />**Proves:** the selected CI graph against the target ref. `npm-beta-v1` and `npm-stable-v1` retain Linux/macOS/Windows Node, plugin and channel contracts, Node compatibility, checks, built-artifact smoke, docs, Python skills, and Control UI; they defer macOS Swift/OpenClawKit, iOS, Android, and native i18n. Other coverage policies use full CI.<br />**Rerun:** `rerun_group=ci`.                                                                             |
| Plugin prerelease       | **Jobs:** `Run plugin prerelease independent validation` and `Run plugin prerelease candidate validation`<br />**Child workflow:** `Plugin Prerelease`<br />**Proves:** independent static and agentic coverage can start before acquisition, while candidate-dependent Docker lanes consume the sealed package and plugin registry identities.<br />**Rerun:** `rerun_group=plugin-prerelease`.                                                                                                                                         |
| Release checks          | **Jobs:** `Run release checks independent validation` and `Run release checks candidate validation`<br />**Child workflow:** `OpenClaw Release Checks`<br />**Proves:** independent install, QA, and live coverage can start before acquisition, while package, cross-OS, and candidate-dependent Docker lanes consume the sealed candidate. Stable and full profiles retain exhaustive live/E2E and release-path coverage.<br />**Rerun:** classify the failed surface and select one concrete release-check group.                     |
| Package Telegram        | **Job:** `Run package Telegram E2E`<br />**Child workflow:** `NPM Telegram Beta E2E`<br />**Proves:** a focused published-package Telegram E2E when `release_package_spec` or `npm_telegram_package_spec` is set. `npm-beta-v1` defers this child; explicit `npm-telegram` and soak retain it. Package Acceptance owns Telegram proof for unpublished candidates when selected.<br />**Rerun:** `rerun_group=npm-telegram` with `release_package_spec` or `npm_telegram_package_spec`.                                                   |
| Product performance     | **Job:** `Run product performance evidence`<br />**Child workflow:** `OpenClaw Performance`<br />**Proves:** release-profile performance (`profile=release`, `repeat=3`, `publish_reports=false`) against the target SHA. Selected for `all` except `npm-beta-v1`, or explicit `performance`; stable/full regressions block, beta results remain advisory. Selected children still finish and prove their report publisher was skipped.<br />**Rerun:** `rerun_group=performance`.                                                       |
| Release decision        | **Job:** `Release Decision`<br />**Child workflow:** none<br />**Proves:** polls the exact recorded child run IDs and attempts, enforces release policy, and publishes an attempt-bound decision artifact. A decisive failure becomes `blocked_diagnostics_running` while unrelated child diagnostics continue.<br />**Rerun:** fix or rerun only the blocking surface.                                                                                                                                                                  |
| Diagnostic drain        | **Job:** `Diagnostic Drain`<br />**Child workflow:** none<br />**Proves:** with `fail_fast=false`, follows every selected exact child to terminal without cancellation and writes timing, failed-job, run-attempt, and Tooling-SHA evidence. Collector cancellation instead writes an immediate `cancelled_with_children` handoff containing active child identities.<br />**Rerun:** recover collection only for `orchestration_error`; product failures do not invalidate the drain.                                                   |
| Execution plan          | **Job:** `Seal release execution plan`<br />**Child workflow:** none<br />**Proves:** persists the original parent attempt, exact child identities and titles, required coverage, gates, reuse identity, and fresh candidate request with exact producer and publisher binding in a stable run-bound artifact. Attempt-two collector recovery restores this artifact instead of redispatching.<br />**Rerun:** restore the existing plan only; a missing plan is an orchestration error.                                                 |
| Umbrella verifier       | **Job:** `Verify full validation`<br />**Child workflow:** none<br />**Proves:** downloads the immutable execution plan plus the exact attempt-bound Release Decision and Diagnostic Drain artifacts, verifies their common digest and parent tuple, and accepts only a strict green decision plus terminal drain.<br />**Rerun:** recover the existing collectors or rerun only the failed product surface; the verifier never reclassifies or redispatches children.                                                                   |

The seven child-dispatch jobs own dispatch and exact identity capture only. They
emit the child run ID, run attempt, and URL, then finish. Release Decision owns
the blocking answer; Diagnostic Drain owns complete terminal evidence. The
immutable execution plan owns child identity across collector attempts. The
decision state is one of `qualifying`, `blocked_diagnostics_running`, `passed`,
`blocked_complete`, `orchestration_error`, or `cancelled_with_children`.
Persistent GitHub API failures are orchestration errors. A child whose workflow
path, display title, ref, Tooling SHA, or run ID changes is a distinct
provenance mismatch. A monotonically newer attempt is accepted only through the
composite-attempt rules in [Continue a failed
validation](/reference/full-release-validation/continuation).

`blocked_diagnostics_running` is safe for immediate diagnosis but not for a
retry until Diagnostic Drain is terminal. `orchestration_error` authorizes
collector recovery against the same exact child identities, never test
redispatch. `blocked_complete` means diagnostics are complete; it does not
claim a drain is still running.

When selected, the umbrella dispatches product performance in artifact-only mode.
`OpenClaw Performance` permits report publication only for scheduled runs or a
manual dispatch that explicitly sets `publish_reports=true`. The artifact-only
guard must complete successfully, proving the publisher job stayed skipped.
Evidence for a selected performance child records
`controls.performanceReportPublication=artifact-only`; the verifier and reuse
selector require the matching normalized performance-child proof whenever that
child is selected. `npm-beta-v1` records performance as deferred instead of
dispatching a child whose advisory result would still delay terminal evidence.

The verifier uploads the canonical manifest as
`full-release-validation-<run-id>-<run-attempt>`. Evidence tooling validates
its artifact ID, digest, producer run, and attempt before downloading that exact
artifact ID. It caps the downloaded ZIP, verifies its bytes against the REST
`sha256:` digest, and streams the only allowed bounded manifest entry without
extracting the archive. A stable-name alias remains temporarily for older
publish consumers. The verifier always prefers the attempt-qualified artifact;
as a transition, it accepts the stable name only for an attempt-1 manifest v2
producer. It rejects that legacy name for later attempts and manifest v3.

Concurrency is keyed by Validation SHA, Tooling SHA, rerun group, release
profile, and effective soak coverage, and does not cancel an older run. The
Release Checks child also separates profiles and effective soak, preserving
independent admission through both workflow levels. Stable/full normalize soak
to enabled, so explicitly enabling it does not admit a duplicate request.
Parent cancellation or timeout leaves adopted
identity-checked children running and records `cancelled_with_children` when
the state collector can complete its cancellation handoff. Cancel an exact
child explicitly when it is no longer useful. Do not run a second foreground
watcher when the SHA-pinned helper already owns the parent; use
`release-ci-summary --watch` only after the helper has returned or when the
parent was dispatched separately.
