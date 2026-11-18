---
doc-schema-version: 1
summary: "The Full Release Validation umbrella stage matrix, evidence reuse, artifact producers, and decision states"
title: "Top-level stages"
read_when:
  - Reading the umbrella stage matrix
  - Debugging a Release Decision or Diagnostic Drain state
---

## Top-level stages

Q (default C) tests C. Admitted P supplies `full-release-validation-state.mjs`
for Release Decision, Diagnostic Drain, manifests, and final validation, applying
[P-owned waivers](/reference/full-release-validation/evidence#release-tooling-waivers).
Publication requires successful FRV, including package qualification and Docker
preparation—not just a passing product decision.

**Whole-parent reuse.** For `rerun_group=all`, `Check for reusable validation evidence`
selects the newest green full validation matching profile, coverage policy, effective
soak, inputs, and exact Q/P identities; child closure equivalence does not apply.

| Policy                            | Eligible target delta                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact-target-full-validation-v1` | Same target                                                                                                                                                                                                                                                                      |
| `split-changelog-release-v1`      | Descendant including selected `CHANGELOG/YYYY.M.PATCH.md`; only that entry, matching `CHANGELOG/records/YYYY.M.PATCH.md`, and root `CHANGELOG.md`. Entry/record additions or modifications and index modifications only; no renames, deletions, other releases, or docs sources. |
| `changelog-only-release-v1`       | Historical root-only receipts                                                                                                                                                                                                                                                    |

Changelog reuse skips every product lane and independently rechecks GitHub comparison,
immutable parent artifact, children, and dispatch logs. Other changes require fresh
Code SHA validation. `reuse_evidence=false` forces a fresh run. Reuse requires `main`
or standard SHA-pinned `release-ci/*` on trusted main lineage; other refs run fresh.

Search rejects incompatible bound manifests (profiles, inputs, targets, non-root runs)
before loading children, logs, or plans. Eligible candidates receive full provenance
and attempt checks. At most seven independent children are read concurrently;
per-child attempts/pagination remain sequential, job data is retained, and all reads
finish before a verdict. Resolution/reuse checkouts need only tooling and release metadata.

**Child reuse.** A green sealed child can outlive a failed, cancelled, or active parent:

- Search bounds: 100 recent dispatch runs, 40 target receipt inventories, five matching
  receipts per role, two minutes. Nonmatching receipts do not consume the five.
- Match target, role, nonempty inputs/defaults, and candidate descriptor bytes. Empty
  inputs equal absent inputs (`github.event.inputs` omits them).
- Require equal Q or authenticated identical workload closure: owning/reusable workflows,
  local actions, complete scripts tree, root configuration/dependencies. Different Q
  requires verified main ancestry; missing, unsupported, or changed closure blocks reuse.
  Control-only intent is insufficient.
- Normal CI additionally retains complete `config`, `packages`, `src`, and `test` trees
  imported by its Q harness; even unrelated changes there invalidate reuse. Other product
  directories come from C and are excluded. Unrelated parent workflow changes alone do
  not invalidate normal CI. Other roles retain all workflows and the full root tree;
  shared-script changes invalidate every child.
- Dispatch logs explain evaluated rejections, reused children, skipped runs, and fresh
  dispatches. Sealing, collectors, and final verification repeat tooling/receipt checks.

**Publication artifacts.** `full-release-artifacts.yml` starts independent npm and
Docker producers:

- Read-only `openclaw-npm-preflight.yml` starts source, SDK, dependencies, and package
  preparation together. One root/core build-and-pack unlocks content/lifecycle checks
  and early `openclaw-npm-package-descriptor-<run-id>-<attempt>` candidate preparation.
  Final qualification joins all successful exact-source proofs, sealing identical
  tarball bytes; the manifest records the immutable descriptor in
  `publicationArtifacts.npmPreflight`. SDK consumer installs retain
  their smaller dependency context.
- Legacy `npm-shrinkwrap.json`: preparation (before descriptor emission) and qualification compare the packed root
  manifest with shrinkwrap root declarations and installed entries. Missing runtime
  dependencies fail despite npm success, locally prepared dependencies, or working
  repacked Docker images. Repair the candidate shrinkwrap and regenerate evidence;
  never repair frozen bytes during qualification.
- Regular final releases produce separate SDK compatibility reports for current npm
  `beta` and `latest` predecessors from one target snapshot. Publication selects its
  channel report/acknowledgement without rebuilding; beta and extended-stable retain
  their required channel.
- Selected official plugins: artifact-only `plugin-npm-release.yml` packs, validates,
  and reads back exact Release SHA tarballs. Release Decision requires sealed
  `publicationArtifacts.pluginNpm`. Prepared publication adopts exact IDs, digests,
  producer/attempt without repacking. Source-only files/fixtures are checked only if packed.
- Normal publication instead repacks/scans with admitted P and its reviewed inventory.
  When P differs from run tooling, `Prepare exact plugin npm artifacts` concurrently
  uses P's packer/scanner for every selected plugin with reviewed findings. Changed
  reviewed hash/path/count fails early, naming package, packed file, and `contentSha256`;
  inspect before updating `scripts/plugin-npm-security-scan.mts` on `main`.
- Npm recovery (direct `OpenClaw NPM Release` preflight-only and FRV standalone):
  follow [original-producer recovery](/reference/full-release-validation/continuation#continue-failed-child-jobs),
  preserving successful preparation/bytes and effective successful proof jobs. Failed
  or unfinished producers are ineligible; final publication requires producer success.
- `docker-release-prepare.yml` builds/smokes both native architectures before approval, including mandatory
  `runtime-assets` for every release, retaining OCI indexes and SBOM/provenance. New
  layers use gzip level 1; cached layers are not forcibly recompressed. Default/browser
  images share local builder cache, not remote transfers. Fresh provenance invalidates
  application layers; fresh runners rebuild runtime setup (including mutable Debian/npm
  updates). Sealed OCI artifacts remain reusable. Hosted VM cleanup reclaims builders;
  builder-volume deletion does not delay post-upload sealing.
- `publicationArtifacts.docker` preparation has no publication secrets or registry-write
  permission. After approval, `Docker Release` verifies source/tag, producer, hashes,
  and image digests, then promotes exact bytes to GHCR/Docker Hub under a registry-write
  and selector-promotion lock. Historical evidence without images uses the same preparation.
- Same-run Docker publication failure: rerun publication, verifying original successful
  preparation/artifacts without rebuilding. Separate publishers require the original
  producer attempt active or successful; this path cannot adopt failed attempts.

**Shared candidate.** Fresh package-facing validation sends the prepared root/core
bundle to a standalone `Full Release Candidate` producer. Its registry serves exact
unpublished core dependencies/selected plugins; npm, pnpm, Bun, and cross-OS installers
start it before resolving root. Published baselines remain upstream. Plugin Prerelease
and Release Checks start independent phases immediately; candidate phases wait and
verify identical package SHA, artifact IDs, service digests, producer attempt, and Docker
archive digest. Bare Docker layers use content-addressed GHCR cache; candidate images
remain immutable GitHub artifacts. Explicit published package specs retain their existing path.

Preparation emits normalized-request digest and seven-day
`full-release-candidate-v2-<request-sha256>` evidence, sealed by the execution plan. Its
bounded manifest binds target/Tooling SHAs, release/soak policy, effective survivor
baselines/scenarios, preparation-plan digest, sorted plugins, producer/publisher
workflow/job/run identities, and package/registry/image identities and expiries. Reuse
selects the newest artifact with ≥14 hours left matching request and exact prepared
tarball digest, revalidating workflow run, publisher job, archive digest, manifest,
producer attempt/job, and every artifact's live metadata. Proven absence creates fresh;
lookup uncertainty or post-selection failure blocks switching. Different tarball bytes
require a new candidate even at the same source SHA.

| Stage / job                                                                                                                                                    | Workflow, proof, and retry                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution — `Resolve target ref`                                                                                                                       | No child; resolve branch/tag/full SHA and selected inputs. Failure: rerun umbrella.                                                                                                                                                                                                                                                                                                         |
| Publication preparation — `Prepare release npm artifacts`, `Qualify release npm artifacts`, `Prepare plugin npm artifacts`, `Prepare release Docker artifacts` | Producers and recovery above; qualifies exact root/core/plugin tarballs and both Docker architectures.                                                                                                                                                                                                                                                                                      |
| Shared candidate — `Acquire full release candidate`                                                                                                            | `Full Release Artifacts` calls `Full Release Candidate` as above. Retry affected package, plugin-prerelease, cross-OS, or live/E2E group with same candidate.                                                                                                                                                                                                                               |
| Vitest and normal CI — `Run normal full CI`                                                                                                                    | `CI`; selected target graph. `npm-beta-v1`/`npm-stable-v1`: Linux/macOS/Windows Node, plugin/channel contracts, Node compatibility, checks, built-artifact smoke, docs, Python skills, Control UI; defer iOS/Android/native i18n. Beta also defers macOS Swift/OpenClawKit; stable retains macOS Swift `tests`/`packages` for shipped app. Other policies: full CI. Retry `rerun_group=ci`. |
| Plugin prerelease — `Run plugin prerelease independent validation`, `Run plugin prerelease candidate validation`                                               | `Plugin Prerelease`; independent static/agentic and candidate Docker phases above. Retry `rerun_group=plugin-prerelease`.                                                                                                                                                                                                                                                                   |
| Release checks — `Run release checks independent validation`, `Run release checks candidate validation`                                                        | `OpenClaw Release Checks`; phases above. Stable/full retain exhaustive live/E2E/release-path coverage. Classify failure; retry one concrete release-check group.                                                                                                                                                                                                                            |
| Package Telegram — `Run package Telegram E2E`                                                                                                                  | `NPM Telegram Beta E2E`; published-package proof with `release_package_spec` or `npm_telegram_package_spec`. `npm-beta-v1` defers; explicit `npm-telegram`/soak retain. Package Acceptance owns selected unpublished-candidate Telegram proof. Retry `rerun_group=npm-telegram` with either spec.                                                                                           |
| Product performance — `Run product performance evidence`                                                                                                       | `OpenClaw Performance`; target SHA, `profile=release`, `repeat=3`, `publish_reports=false`. Selected for `all` except `npm-beta-v1`, or explicit `performance`; selected regressions block every profile. Retry `rerun_group=performance`.                                                                                                                                                  |
| Release decision — `Release Decision`                                                                                                                          | No child; poll exact recorded runs/attempts, enforce policy, publish attempt-bound decision. Decisive failure: `blocked_diagnostics_running`. Fix/retry blocking surface only.                                                                                                                                                                                                              |
| Diagnostic drain — `Diagnostic Drain`                                                                                                                          | No child; `fail_fast=false` follows all selected children to terminal without cancellation, recording timings/failures/attempts/Tooling SHA. Collector cancellation immediately records `cancelled_with_children` and active identities. Recover collection only for `orchestration_error`; product failures do not invalidate drain.                                                       |
| Execution plan — `Seal release execution plan`                                                                                                                 | No child; seals original attempt, child identities/titles, coverage/gates/reuse, candidate request and producer/publisher binding. Attempt-two recovery restores existing plan, never redispatches; missing plan is orchestration error.                                                                                                                                                    |
| Umbrella verifier — `Verify full validation`                                                                                                                   | No child; immutable plan plus attempt-bound Decision/Drain must share digest/parent tuple. Requires strict green decision and terminal drain. Recover collectors/failed surface; never reclassify/redispatch.                                                                                                                                                                               |

Seven dispatch jobs only capture/emit child run ID, attempt, and URL, then finish.
Decision owns blocking; Drain owns terminal evidence; immutable plan owns identities
across collector attempts. States: `qualifying`, `blocked_diagnostics_running`,
`passed`, `blocked_complete`, `orchestration_error`, `cancelled_with_children`.

- Diagnose `blocked_diagnostics_running` immediately; wait for terminal Drain before retry.
  `blocked_complete` means diagnostics finished. `orchestration_error` permits collector
  recovery with identical children, never test redispatch.
- Persistent API failures are orchestration errors. Changed workflow path/title/ref,
  Tooling SHA, or run ID is provenance mismatch. Newer attempts require
  [composite-attempt rules](/reference/full-release-validation/continuation).
- Selected performance must finish with successful artifact-only guard proving publisher
  skipped. Evidence records `controls.performanceReportPublication=artifact-only`; verifier
  and reuse require matching normalized child proof. Publication is allowed only for
  scheduled runs or explicit manual `publish_reports=true`. `npm-beta-v1` records deferred, no child.
- Manifest `full-release-validation-<run-id>-<run-attempt>`: validate ID/digest/producer/attempt
  before exact-ID download; cap ZIP, verify REST `sha256:`, stream sole bounded manifest
  entry without extraction. Prefer attempt-qualified artifact; stable-name fallback only
  for attempt-1 manifest v2, never later attempts or v3.
- Concurrency keys: Validation SHA, Tooling SHA, rerun group, profile, effective soak; no
  cancellation of older runs. Release Checks also separates profile/soak. Stable/full
  normalize soak enabled, preventing duplicate admission for explicit enablement.
- Parent cancellation/timeout leaves identity-checked adopted children running; collector
  records `cancelled_with_children` when possible. Explicitly cancel unneeded exact children.
  No second foreground watcher while SHA-pinned helper owns parent; use
  `release-ci-summary --watch` only after helper returns or for separately dispatched parents.
