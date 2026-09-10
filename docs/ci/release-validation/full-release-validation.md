---
summary: "The Full Release Validation umbrella, release publish, and Docker Release dispatch"
read_when:
  - You are dispatching or rerunning Full Release Validation
  - You are publishing a release or a Docker image
title: "Full Release Validation"
sidebarTitle: "Full Release Validation"
---

The Full Release Validation umbrella, release publish, and Docker Release dispatch. Part of the [Release validation workflows](/ci/release-validation) index.

## Full Release Validation

`Full Release Validation` is the manual release umbrella. Every run binds an
exact Validation SHA + Tooling SHA tuple and rejects an `expected_sha` mismatch
before child dispatch. Validation SHA maps to the Code SHA for product
validation or the Release SHA for changelog-only validation; it is not a third
release identity. Beta-publish maps to `release_profile=beta` with
`run_release_soak=false`. A canonical beta's `all` run records `npm-beta-v1`:
it retains Node and Control UI CI, Plugin Prerelease, package/install/cross-OS
checks, and QA parity, while deferring native apps, performance, and Telegram
confidence. Broad live/E2E and QA-live remain outside that bounded gate.
Postpublish-confidence uses the exact published package with soak or explicit
focused groups. Regular stable releases use `release_profile=stable` and
`npm-stable-v1`: only native apps are deferred; stable soak, blocking performance,
Node on all three OS families, Control UI, package acceptance, and QA remain.
Both npm scopes require an exact release version and validated matching branch
or tag context. Numeric regular corrections are supported; extended-stable,
uncontextualized `main`, full profiles, and explicit `ci` groups retain full CI.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

The live/E2E selected-ref validator fetches the complete commit and ref history
with a sparse checkout. Ancestry and release-ref checks remain unchanged, while
historical file contents stay out of this metadata-only job. Build and test jobs
check out their own complete source trees.

`OpenClaw Release Publish` is the manual mutating release workflow. Dispatch
regular beta and stable publishes from a protected lightweight
`release-publish/<tooling-sha12>-<epoch>` tag at the frozen Tooling SHA after the
release tag exists and after the OpenClaw npm preflight has succeeded (the preflight runs
`pnpm plugins:sync:check` among its checks). The tag still selects the exact
release commit, including a commit on `release/YYYY.M.PATCH`; Tideclaw alpha
publishes keep using their matching alpha branch. For current validation runs,
set `preflight_run_id` and `full_release_validation_run_id` to the same successful
Full Release Validation run ID and pin `full_release_validation_run_attempt`.
The publisher resolves the independent `Full Release Artifacts` producer from
that validation manifest's sealed `publicationArtifacts.npmPreflight` descriptor.
The producer ID alone does not carry Full Release Validation authorization.

`Docker Release` requests the `docker-release` environment approval in a
separate job after source identity and image preparation succeed (or prepared
artifacts are supplied). Approval waits stay outside `docker-release-publish`;
only the approved publisher enters that global registry/alias lock. It then
revalidates the immutable source, prepared artifacts, attestations and alias
state before writing. Docker Hub credentials remain required caller-provided
secrets. Failed preparation, denied approval and cancellation cannot publish.

Historical recovery may still supply a separate successful `OpenClaw NPM Release`
preflight run ID alongside the matching successful Full Release Validation run
and attempt. Create the tooling tag with the [release publish commands](/reference/RELEASING#regular-release-publish-automation);
real core npm, plugin npm, or ClawHub publication from `main` is rejected before
child dispatch. Docker-only recovery may still use `main`.

The publisher dispatches `Plugin NPM Release` for all
publishable plugin packages, dispatches `Plugin ClawHub Release` for the same
release SHA, then dispatches `OpenClaw NPM Release` after plugin npm succeeds.
Stable Windows promotion is optional: supply both an exact `windows_node_tag`
and candidate-approved `windows_node_installer_digests` to dispatch its signed
installers after GitHub release finalization. Omit both to skip Windows.
For npm-stable evidence, when the tagged `apps/android/version.json` matches
the stable tag's base version, a separate native qualification job starts full
CI for the exact release SHA with Android enabled. A successful result is revalidated
after core publication before the separate Android job creates its existing
approval receipt and dispatches the tag-owned APK workflow. This keeps frozen
release tags usable without allowing narrower npm evidence to authorize an
unqualified native build. Native failure remains visible and prevents Android
approval; core npm and GitHub release finalization do not wait for it. The whole
parent can remain active after core publication while native qualification
finishes. Existing full evidence and macOS's independent validation retain their
native qualification contracts. A mismatched Android pin skips both native
qualification and APK publication, with the pin, release train, and shared
mobile cutter (`scripts/mobile-release-version.ts --prepare`) remedy recorded
in the parent summary and release proof.
Focused plugin-only repairs use `plugin_publish_scope=selected` with a nonempty
package list. Plugin-only `all-publishable` runs require the same immutable npm
preflight and Full Release Validation evidence as a core publish.

```bash
PUBLISH_REF="release-publish/<tooling-sha12>-<epoch>"
FRV_RUN_ID="<successful-full-release-validation-run-id>"
FRV_RUN_ATTEMPT="<successful-full-release-validation-run-attempt>"
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_attempt="$FRV_RUN_ATTEMPT" \
  -f npm_dist_tag=beta
```

For pinned commit proof on a fast-moving branch, use the helper instead of
`gh workflow run ... --ref main -f ref=<sha>`:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
VALIDATION_SHA="<full-release-candidate-sha>"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

GitHub workflow dispatch refs must be branches or tags, not raw commit SHAs. The
helper pushes a temporary `release-ci/<sha>-...` branch at a trusted Tooling
SHA, passes the requested Validation SHA through `ref` and `expected_sha`, reuses
strict exact-target evidence when available, and verifies every child workflow
`headSha` matches the Tooling SHA. Record that Tooling SHA once and never refresh
it from moving `main`. Regular release branches accept only their final package
version or a matching beta prerelease; Tideclaw alpha validation uses its exact
alpha tag and matching alpha branch.

`release_profile` controls live/provider breadth passed into release checks. The
manual release workflows default to `stable`; use `full` only when you
intentionally want the broad advisory provider/media matrix. Stable and full
release checks always run the exhaustive live/E2E and Docker release-path soak;
the beta profile can opt in with `run_release_soak=true`.

`fail_fast` defaults to `false`: the umbrella waits for each dispatched child
workflow and reports its independent failures together. Set `fail_fast=true`
only when cancelling a child after its first failed job is more useful than the
complete failure inventory. In Release Checks, this also enables the Matrix QA
CLI's own first-scenario cancellation.

- `beta` keeps the fastest OpenAI/core release-critical lanes.
- `stable` adds the stable provider/backend set.
- `full` runs the broad advisory provider/media matrix.

The umbrella records dispatched child run ids, and `Verify full validation`
checks them during that parent attempt. Parent cancellation or timeout leaves
adopted exact children running; cancel one explicitly when it is no longer
needed.

For recovery, classify product, harness/tooling/provenance,
infrastructure/credential, and wrapper failures before editing. Only confirmed
product failure changes the Code SHA. Use one diagnosis, one fix when needed,
and one narrow `rerun_group` retry, then reassess; never widen automatically to
`all`. Narrow evidence is not publish authorization by itself.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected ref once into a `release-package-under-test` tarball, then passes that artifact to cross-OS checks and Package Acceptance, plus the live/E2E release-path Docker workflow when soak coverage runs. That keeps the package bytes consistent across release boxes and avoids repacking the same candidate in multiple child jobs. For the Codex npm-plugin live lane, release checks either pass a matching published plugin spec derived from `release_package_spec`, pass the operator-supplied `codex_plugin_spec`, or leave the input blank so the Docker script packs the selected checkout's Codex plugin.

Full Release Validation concurrency is keyed by Validation SHA, Tooling SHA,
rerun group, release profile, and effective soak coverage with
`cancel-in-progress: false`. Release Checks uses the same coverage identity in
each phase, so beta, stable, and full requests do not queue behind each other.
Stable/full always include soak; setting their soak flag explicitly does not
create another concurrency group. Parent cancellation does not cancel adopted
children.

In the canonical repository's `hybrid` runner mode, target resolution, evidence
reuse, candidate discovery, candidate binding, and candidate resolution use
the small Blacksmith runner pool. These serial jobs otherwise compound hosted
runner admission delays before tests can start. Other modes and noncanonical
repositories retain GitHub-hosted runners; the reusable harness also honors
its explicit hosted-runner override. Long-running decision and diagnostic
collectors remain hosted.
