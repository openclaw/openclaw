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
- Tooling/provenance, credential/infrastructure, wrapper, approval, or selector
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
Do not leave the GitHub release drafted while you recover: once npm is out, run
`gh release edit v<version> --repo openclaw/openclaw --draft=false --latest`
first (see [regular release](regular-release.md#publish-and-verify)), then repair
the parent: run the beta-to-stable dist-tag sync, sweep the failed parent's
stale `waiting`/`queued` children (reject their gate and cancel them, per
`$release-openclaw-ci` Publish children), and dispatch a new parent with the
same inputs. It recognizes published bytes and only runs ClawHub, GitHub
release evidence, and Docker. Never approve a ClawHub child by hand; without
the parent's recovery-approval artifact its publish jobs fail
`Artifact not found`.

Follow `docs/reference/RELEASING.md`: once a beta tag has been pushed, use the
next beta number rather than deleting or recreating it, even before npm
publication. Published npm versions and final stable/extended-stable tags remain
immutable. Routine release authority does not authorize destructive tag
rewrites; an exceptional operator request must name its exact scope. Mac-only
packaging recovery keeps the original tag and follows
[platform publication](platform-publication.md).

## Registry selectors

Promote through the restricted release-ops
`openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow.
Unlike package publication, npm selector management requires `NPM_TOKEN`.
Prefer repairing that workflow's token path. Point `latest`, `beta`, or
`extended-stable` only at the operator-approved already-published version, then
verify cache-bypassed registry readback.

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
