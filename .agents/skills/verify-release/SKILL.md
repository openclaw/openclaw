---
name: verify-release
description: "Verify regular or extended-stable OpenClaw releases against the exact publication surfaces, workflow identities, package provenance, smoke tests, and live Gateway behavior expected for that release track."
---

# Verify Release

Use this when asked whether an OpenClaw release is fully released, published,
promoted, smoke-tested, or live-verified. This is a verification skill, not a
publish skill; use `$release-openclaw-maintainer` before changing release state.

## Rules

- Resolve short suffixes like `.27` to the concrete CalVer version from the
  current date/context, then say the resolved version.
- Resolve the release track before choosing checks. Regular beta/stable uses a
  GitHub Release and the orchestrated platform graph. Extended-stable uses the
  canonical `extended-stable/YYYY.M.33` branch, npm `extended-stable`, and only
  the surfaces named by the current release policy. Never fail one track for an
  artifact owned only by the other.
- Verify live state. Do not trust local checkout state, release notes, or old
  memory as current truth.
- If the checkout is dirty or divergent, use it only for scripts/reference.
  For version metadata, fetch from GitHub release/tag or unpack the tag tarball
  under `/tmp`.
- Never print secrets. Use inherited live keys only for scoped smoke commands.
- Keep the final terse: `yes/no`, evidence bullets, caveats, cleanup.

## Regular beta/stable checks

Use these checks only for the regular orchestrated release track.

1. GitHub release:
   - `gh release view v<VERSION> --repo openclaw/openclaw --json tagName,name,publishedAt,isDraft,isPrerelease,targetCommitish,url,body,assets`
   - Confirm stable releases are not draft/prerelease.
   - Confirm release body has npm, CI, plugin npm, ClawHub, mac/appcast evidence
     links when expected.
   - Confirm assets expected for stable mac releases are uploaded: zip, dmg,
     dSYM, dependency evidence, immutable full-validation manifest,
     postpublish evidence, and stable-main closeout manifest.
   - Download each immutable evidence asset and its `.sha256` companion, then
     verify the checksum before trusting the release record.
2. Root npm:
   - `npm view openclaw@<VERSION> version dist-tags.latest dist.tarball dist.integrity time.<VERSION> --json`
   - `latest` must equal `<VERSION>` for stable.
   - Record tarball, integrity, publish time.
   - Confirm the release postpublish evidence records
     `npmRegistrySignaturesVerified: true` and
     `npmProvenanceAttestationMatched: true`.
3. Plugin publish set:
   - Get exact tag metadata from GitHub, not the local checkout when dirty:
     download `https://api.github.com/repos/openclaw/openclaw/tarball/v<VERSION>`
     into `/tmp/openclaw-v<VERSION>-src`.
   - Count `extensions/*/package.json` with
     `openclaw.release.publishToNpm === true` and
     `openclaw.release.publishToClawHub === true`.
   - Compare expected counts to workflow job counts:
     `gh api repos/openclaw/openclaw/actions/runs/<RUN>/jobs --paginate`.
   - Each expected npm plugin must have version `<VERSION>` and
     `dist-tags.latest === <VERSION>`.
4. ClawHub:
   - Check the Plugin ClawHub Release workflow conclusion and publish job count.
   - Use OpenClaw itself for live registry proof:
     `openclaw plugins search <known-plugin> --json`.
   - Install one official plugin from ClawHub in an isolated HOME:
     `openclaw plugins install clawhub:@openclaw/matrix --pin`.
     Prefer `matrix` unless that plugin is not in the expected set.
5. Release workflows:
   - Verify conclusions for release notes evidence links:
     Full Release Validation, OpenClaw Release Checks, OpenClaw NPM Release,
     Plugin NPM Release, Plugin ClawHub Release, mac preflight/validation/publish
     when stable mac assets are expected.
   - For stable, verify `OpenClaw Stable Main Closeout` succeeded and its
     manifest records the matching release tag, current rollback drill, stable
     soak, and blocking performance evidence.
   - Summarize only relevant successful/failed jobs; ignore routine skipped
     optional lanes unless the release body promised them.

## Extended-stable checks

Extended-stable intentionally has no GitHub Release to use as a release ledger.
Start with the immutable tag and canonical branch, then reconstruct the exact
publication chain from live workflow and registry state.

1. Identity:
   - Resolve `v<VERSION>` and require a final `YYYY.M.PATCH` with `PATCH >= 33`
     and no prerelease or correction suffix.
   - Derive `extended-stable/YYYY.M.33`; require the tag SHA to be contained in
     that remote branch. Require tag-to-tip equality only while verifying the
     active pre-publication candidate; later maintenance patches legitimately
     advance the shared branch.
   - Read version and package metadata from that tag, not from the local
     checkout. Every npm-publishable official plugin must declare `<VERSION>`.
   - Confirm `gh release view v<VERSION>` has no published GitHub Release. A
     Git tag is required; a GitHub Release would indicate the wrong track ran.
2. Workflow chain:
   - Find the successful exact-head `OpenClaw NPM Release` preflight, `Full
Release Validation`, `Plugin NPM Release`, and real `OpenClaw NPM Release`
     publish runs on the canonical branch.
   - Require every run's `headSha` to equal the release SHA. Require Full
     Release Validation to be `rerun_group=all`, use `release_profile=stable`,
     record blocking soak/performance evidence, and retain the exact successful
     `run_attempt`.
   - Confirm the real core publish references those exact three run IDs and the
     saved validation attempt. Its prepared tarball digest and validation
     manifest must bind to the release SHA and canonical workflow ref.
3. Root npm:
   - `npm view openclaw@<VERSION> version dist.tarball dist.integrity time.<VERSION> --json`
   - `npm view openclaw@extended-stable version --json`
   - Both version reads must equal `<VERSION>`. `latest` is deliberately not an
     extended-stable acceptance condition.
4. Prepared core npm packages:
   - Read `corePackageTarballs` from the saved npm preflight manifest. For every
     listed package, require the exact version and its `extended-stable`
     selector to equal `<VERSION>`.
   - This includes `@openclaw/ai` when the target depends on the split AI
     runtime and may include `@openclaw/gateway-protocol` or
     `@openclaw/gateway-client` when that frozen target publishes them.
5. Official plugin npm set:
   - Derive the exact `publishToNpm === true` inventory from the tag tarball.
   - Require every package version and every package's `extended-stable`
     selector to equal `<VERSION>`.
   - Compare the inventory with the Plugin NPM Release plan, publish jobs, and
     complete registry readback. Do not infer scope from changed paths.
6. Provenance and install paths:
   - Run `node --import tsx scripts/openclaw-npm-postpublish-verify.ts
<VERSION>` from trusted current tooling. Require registry signatures and
     npm provenance to bind the package to the canonical extended-stable
     workflow branch. Use the saved publish run, preflight manifest, and
     tarball digest to bind its exact bytes to the release SHA.
   - Preserve the verifier output and exact workflow URLs as release evidence.
7. Docker publication:
   - Find the successful tag-triggered `Docker Release` run at the release SHA.
   - Require exact default, slim, browser, and architecture images in GHCR and
     Docker Hub, with successful source and attestation verification.
   - Require `extended-stable`, `extended-stable-slim`, and
     `extended-stable-browser` to resolve to that release's verified digests.
     Confirm regular `latest`, `main`, and their variants did not move.
   - If aliases were repaired, require a successful current-main `Docker Channel
Promotion` run for the exact tag. It must promote verified source digests
     without rebuilding immutable images.
8. Partial-publish recovery:
   - An immutable package version that already exists is success to reuse, not
     permission to republish it.
   - If only the root `openclaw` selector is stale, use the repair command
     emitted by the core publish workflow. If a prepared core-package or plugin
     selector is stale, use the approved credential-isolated tag repair path;
     the generated command does not cover those packages. Repeat the complete
     registry readback afterward.
9. Excluded surfaces:
   - Do not require ClawHub, macOS, Windows, mobile, website, private dist-tags,
     regular `latest`, or a GitHub Release unless the current release policy
     explicitly adds that surface to extended-stable.

## Shared live smoke

After the track-specific publication checks pass:

1. Published package smoke:
   - In `/tmp`, isolated HOME:
     `npm exec --yes --package openclaw@<VERSION> -- openclaw --version`.
   - Run at least one harmless command that touches the published CLI surface,
     for example `plugins --help` or `gateway --help`.
2. Dev Gateway live model smoke:
   - Use temp HOME/workspace, not the user's normal state:
     `HOME=/tmp/openclaw-release-smoke/home OPENCLAW_WORKSPACE=/tmp/openclaw-release-smoke/work pnpm openclaw --dev gateway run --auth none --force --verbose`.
   - Health check via CLI: `openclaw --dev gateway health --json`.
   - Run one Gateway-backed agent turn with inherited `OPENAI_API_KEY`, short
     prompt, explicit session key, JSON output, and a known-available model.
   - If the configured default model fails as unavailable, record that caveat
     and retry with the newest known-good OpenAI model instead of declaring the
     release failed.
   - Stop the gateway and verify the port is not listening.

## Caveats To Report

- Dist-tag caveat: stable `latest` is release truth; if optional `beta` mirrors
  still point at a beta version, report it as a caveat, not a stable-release
  blocker, unless the user asked to verify beta promotion.
- Track caveat: state which release track was resolved and which publication
  surfaces are intentionally absent. For extended-stable, never describe the
  absence of regular-release artifacts as incomplete publication.
- Divergent checkout caveat: say when local source SHA differs from release tag
  or origin and which live sources were used instead.
- Smoke caveat: distinguish Gateway-backed agent success from local embedded
  fallback. A valid Gateway smoke has health OK plus gateway log/run id for the
  agent call.
