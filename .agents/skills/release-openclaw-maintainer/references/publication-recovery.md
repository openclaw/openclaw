# Publication authentication and recovery

Use `$one-password` before any credential operation, and `$release-private`
when available for maintainer credential locators. Core package publishing is
GitHub OIDC trusted publishing; never substitute `NPM_TOKEN` or plugin OTP
commands. GitHub's `npm-release` environment must be approved by
`@openclaw/openclaw-release-managers` on the parent and on each npm child; the
approved parent writes the attested release approval receipt that lets the
ClawHub child run without its own gate.

The regular and extended-stable publish parent runs from the protected
`release-publish/<tooling-sha12>-<epoch>` tag minted at the pinned Tooling SHA;
use the regular candidate helper's printed command or the extended-stable
publication reference for that track. Do not dispatch npm/plugin/ClawHub
publication from a moving main parent. Docker-only recovery may use main.
Extended-stable direct npm workflow recovery is a separate supported main route;
follow [trusted-main npm recovery](extended-stable-publish.md#trusted-main-npm-recovery)
for plugin source inputs and the matching core evidence handoff. It does not use
the shared publish parent or authorize ClawHub publication.
Tideclaw alpha uses its matching alpha branch and its owning skill.

Publication promotes previously qualified bytes. Bind the successful Full
Release Validation manifest, exact target SHA, successful attempt, and npm
preflight artifact identities. Current manifests contain npm qualification, so
both run-id inputs use that same run; historical manifests may need separate
npm preflight. Never rebuild as an implicit retry. Selected plugin repairs
require a nonempty `plugin_publish_scope=selected` package list; all-publishable
runs still need full immutable evidence even with core npm disabled.

Classify a failure before changing Git state:

- Product defect: repair the release branch, freeze a new Code SHA, replace
  downstream evidence; after npm publication use a new beta/version.
- Changelog-only defect: replace Release SHA and reuse Code SHA evidence only
  after proving the exact changelog delta.
- Tooling, source mismatch, credential, infrastructure, wrapper, approval, or selector
  failure: keep the candidate and recover the smallest failed surface. Change
  Tooling SHA only when needed and record the invalidated evidence.

After one diagnosis, fix when needed, and narrow retry, reassess. Do not rerun
all phases or scan moving main automatically. Operator-authorized beta-attempt
limits count admitted product attempts, not infrastructure retries.

## Published version, failed parent

Registry propagation may briefly return E404 after a successful npm child.
Use bounded `--prefer-online` reads and preserve the verified tarball/integrity
metadata. For an already-published version, run:

```bash
OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=refs/tags/release-publish/<tooling-sha12>-<epoch> \
OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=<tooling-sha> \
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
pnpm release:verify-beta -- <published-version> ... --skip-github-release
```

Run the verifier from a checkout of the Release SHA, not the tooling checkout,
and only after `npm view openclaw versions --prefer-online` lists the version
(5-6 minutes after the child's `+ openclaw@<version>`).
Use the original successful child run IDs and evidence output path with the
beta verifier. Restore the draft, dependency evidence asset, proof section and
finalization from that evidence. Never rerun publication for bytes already
published. A failed postpublish confidence lane does not authorize unpublishing.
Keep the selected publisher's finalization checks intact while recovering.
The normal direct route verifies npm and Docker before activation; the prepared
button also verifies ClawHub downloads. Do not manually un-draft a release to
bypass a failed gate. The direct publisher's explicit `finalize_release_before_docker=true`
option changes that ordering, not the validation requirements.

Repair a stale beta floor through the dist-tag owner and inspect the failed
parent's exact children before rejecting stale gates or canceling them. Resume
through the selected route with the same qualified bytes and inputs; direct
publication uses the successful original core run, while prepared publication
uses a new button run with the same readiness artifact. Keep the original run
attempts and required approvals. Do not substitute a manual child approval for
the parent's authorization. See `$release-openclaw-ci` Publish children for
stale-child cleanup.

Follow the [release policy](../../../../docs/reference/RELEASING.md): once a beta tag has been pushed, use the
next beta number rather than deleting or recreating it, even before npm
publication. Published npm versions and final stable/extended-stable tags remain
immutable. Routine release authority does not authorize destructive tag
rewrites; an exceptional operator request must name its exact scope. Mac-only
packaging recovery keeps the original tag and follows
[platform publication](platform-publication.md).

## Interrupted preparation and publication

Keep `request.json`, `dispatch.json`, and `dispatch.next.json` when recovering.
A missing child run ID means the dispatch is unconfirmed; inspect Actions before
trying again. Resume partial preparation on the same protected tooling tag with the original
`publish_inputs` and `preparation_request` containing the verified `npmRunId` and
`clawhubRunId`. Missing or expired
artifacts also require reconciliation; they do not authorize another dispatch.

If reconciliation proves that a preparation child never existed, dispatch only
that missing owner from the original protected tooling tag, with the exact source
SHA as `ref` and `publish_scope=all-publishable`. For Plugin NPM Release, use
`preflight_only=true`, `trusted_publisher_preflight=false`, and `npm_dist_tag=default`
(`extended-stable` for that track). For Plugin ClawHub Release, use `dry_run=true`.
Then supply both verified positive child IDs; adoption dispatches no new workflow.

Publication records distinguish `unknown` (no confirmed publisher), `unverified`
(a returned ID without an observed attempt), and `acknowledged` (verified original
publisher and attempt). Preserve the original `release-button-dispatch-<run>-<attempt>`
artifact before its 30-day expiration. For an acknowledged request, verification
is read-only and repeatable from the same protected tooling:

```bash
node scripts/openclaw-release-ready.mjs verify --request /path/to/dispatch.json
```

Unknown, unverified, missing, or inconsistent records require manual reconciliation
of the original button and publisher. Do not adopt a newer run or attempt, edit
an uncertain record into a success receipt, or rerun the dispatch job. Retained
`dispatch.next.json` is evidence to inspect, not publication authority.

For a failed nonpublishing preparation child, rerun all of that child's jobs to
produce a complete package set from one attempt, then only the outer **Verify
and seal prepared publication** job. After publication has been dispatched,
rerun only failed verification jobs when the publisher succeeded; otherwise
inspect its children and follow the recovery route above. Never repeat an
uncertain dispatch or rerun all publication jobs to fix a download failure.

Explicit ClawHub recovery uses `recovered_clawhub_run_id` and
`recovered_clawhub_run_attempt` to name the original child. Keep the original
parent's tooling, inputs, run ID, and attempt. Do not reuse an approval from another
child. Docker-only recovery does not recover canceled ClawHub publication;
verify and recover that surface separately.

## Registry selectors

Beta-to-stable promotion and stable selector recovery remain supported after the
exact final release passes stable/full validation, soak, and blocking performance.
Beta-profile evidence or a publication waiver cannot replace those prerequisites.

Use the restricted release-ops
`openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow with
`mode=promote_beta_to_latest` to promote an already-published final version from
`beta` to `latest`, or `mode=sync_stable_dist_tags` to recover stable selectors.
The operator must verify successful qualification for the exact target before
dispatch. These modes check tag/package identity and selectors; they do not run
or authenticate Full Release Validation. A `-beta.N` prerelease cannot be promoted
through this final-version route.

The same workflow supports the stable-to-beta floor and extended-stable promotion.
Its `sync_beta_to_stable` mode only updates `beta` to the already-published stable
version; it does not publish stable or substitute for stable validation. npm
selector management requires `NPM_TOKEN`. Verify cache-bypassed registry readback
after an approved change.

To promote an already-published core version to `extended-stable`, use
`mode=promote_extended_stable` with an exact public final release tag after
[openclaw/releases#27](https://github.com/openclaw/releases/pull/27) is merged
and available on the release repository's `main`:

```bash
gh workflow run openclaw-npm-dist-tags.yml \
  --repo openclaw/releases --ref main \
  -f mode=promote_extended_stable -f tag=vYYYY.M.PATCH
```

Replace `vYYYY.M.PATCH` with the approved final extended-stable release tag
(patch `33` or higher, without a suffix). Extended-stable fixes increment the
patch (`33`, `34`, `35`, and so on), never a correction suffix. Regular stable/beta
promotion and sync reject patch `33`
or higher, including the scheduled beta floor. Promotion can
select a newer version or roll back to an older one, including historical
unsuffixed extended-stable final versions; new-publication eligibility does not
apply, but the channel/patch boundary still does. This mode
writes only core `openclaw`'s
`extended-stable` selector, leaving `latest`, `beta`, plugins, other prepared-core
packages, Docker, Git tags, and GitHub Releases untouched. It neither republishes
nor changes installed clients. Do not use publish resume to roll back a rejected
release. Coordinate separately with any active publisher before retagging.

Wait for successful readback and retain the run's previous/target summary. An
already-correct selector is a no-op; readback retries never repeat the write.
If a write is unconfirmed or readback fails, inspect the live registry before
retrying. Docker channel promotion remains a separate approval-gated
`docker-channel-promote.yml` dispatch from `openclaw/openclaw` main with an
existing extended-stable image tag; its channel is derived from that version.

Immediately after publishing or promoting to `latest`, dispatch that same
release-ledger workflow to repair the beta floor: raise missing or older beta
selectors to each package's own latest, preserve newer betas, and verify the
selected core/plugin roster. The scheduled repair is only a backstop. Use the
documented owner recovery for packages the ledger does not cover; do not lower
a newer beta merely to make the selectors equal.

If the workflow is unavailable, use the approved `$one-password` / `$npm`
workflow in its persistent tmux session and private credential locators.
Authenticate as the intended npm owner and keep secrets/OTPs out of output.
Do not invent a credential retrieval or login procedure in this skill.

```bash
npm view openclaw dist-tags --json --prefer-online
npm view openclaw@latest version dist.tarball --json --prefer-online
```

An existing tag may still receive validation-only `preflight_only=true` to
verify packaging after publish; it does not authorize republishing.

## Check the bootstrap token

Before publishing a never-published npm package, check the repository's actual
`NPM_TOKEN` in an approved GitHub Actions job. Disable shell tracing, write the
token to a private temporary npmrc, and run `npm whoami` against
`https://registry.npmjs.org` with that file and an otherwise clean environment.
Suppress account output, remove the temporary file, and retain the run URL.
Never print or upload the token. A local login or secret update time is not a
substitute for this check. Successful authentication does not establish package
permissions or approve publication; failures go to the credential owner.
