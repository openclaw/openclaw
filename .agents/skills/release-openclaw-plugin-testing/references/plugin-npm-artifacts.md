# Plugin npm artifact proof

## Plugin npm Artifact Qualification

For a publication candidate, Full Release Validation owns plugin npm artifact
qualification. Supply its publication selection at dispatch; the all-group
parent invokes `plugin-npm-release.yml` in artifact-only mode against the exact
Release SHA, requires successful tarball readback, and records the immutable
aggregate descriptor in `publicationArtifacts.pluginNpm`. Release Prepare and
publication must adopt that exact descriptor rather than repacking plugins.

Use a standalone trusted-workflow preflight only for a focused diagnostic or a
selected-plugin repair that is outside a regular publication candidate:

```bash
release_sha="$(git rev-parse origin/release/2026.7.1)"
gh workflow run plugin-npm-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f preflight_only=true \
  -f publish_scope=selected \
  -f plugins=@openclaw/meta-provider \
  -f ref="${release_sha}" \
  -f npm_dist_tag=default
```

Do not pass `release_publish_run_id`. Require the workflow to finish
`verify_plugin_npm_preflight` successfully. Record the run URL, workflow SHA,
and source SHA. The workflow first creates the staging/readback artifact
`plugin-npm-package-source-<source-sha>-<extension-id>` containing
`npm-pack.json`, `preflight-manifest.json`, and the tarball. It then uploads the
final consumer artifact
`plugin-npm-package-<extension-id>-<version>-<route>-<run-id>-<attempt>` containing
the tarball and `plugin-publication-manifest.json`.

Record the final artifact name and digest separately. The manifest uses
`openclaw.plugin-publication-artifact/v1` and records the target SHA, package
manifest hashes, publication route and policy, and tarball hashes and inventory.
This standalone proof is validation-only; it does not authorize or stage
publication and cannot replace Full Release Validation's manifest-bound
descriptor. The artifact inventory, rather than the unpacked source tree, is
the security and package-content boundary: source-only fixtures are irrelevant.
Package-owned test and fixture paths outside shipped runtime and skill assets
fail qualification; shipped runtime remains security-scanned. Bundled
`node_modules` stays with dependency evidence rather than plugin-source policy.
The separate `trusted_publisher_preflight=true` OIDC check requires a protected
`release-publish/<tooling-sha12>-<epoch>` dispatch tag and runs in `npm-publish`.
Real publication also requires that tooling tag; a direct human dispatch waits
for its `npm-release` approval job before publishing.
For an already-published version,
require npm `dist.integrity` and `dist.shasum` to match the verified tarball.
Treat only missing or provably older dist-tags as repairable; newer or
incomparable selectors are a blocker.
