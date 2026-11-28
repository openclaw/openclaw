## Extended-stable checks

Extended-stable has a GitHub Release with shared release evidence but no native
or ClawHub artifacts. Verify it alongside
the live tag, workflow, registry, provenance, and image state.

1. **Identity:** require final `v<VERSION>` at patch `33+`, with no suffix,
   contained in `extended-stable/YYYY.M.33`. Only an active candidate must equal
   the tip. Root and every publishable official plugin must declare `<VERSION>`.
   Require the Git tag and a public, non-prerelease GitHub Release whose title
   and canonical body match the tag. Require `isLatest=false`, the dependency
   evidence, immutable Full Release Validation manifest, postpublish evidence,
   and their checksums. Require no native or ClawHub assets.
2. **Workflow chain:** find the successful parent release run plus its
   preflight, complete validation, plugin npm, and core publish children.
   Require a protected `release-publish/*` parent and canonical `release-ci/*`
   validation producer with verified workflow SHA provenance. Validation must
   use `rerun_group=all`, `release_profile=stable`, blocking soak/performance,
   and the saved attempt. Core publish must reference all three run IDs and bind
   its manifest, workflow ref, and tarball digest to the release SHA.
3. **Registry:** require exact and `extended-stable` selectors to return
   `<VERSION>` for root, every preflight `corePackageTarballs` entry, and every
   `publishToNpm === true` official plugin derived from the tag. Compare the
   plugin plan, jobs, and complete readback; never infer inventory from diffs.
4. **Provenance:** from trusted current tooling, run
   `node --import tsx scripts/openclaw-npm-postpublish-verify.ts <VERSION>`.
   Require signatures, canonical-branch provenance, and publish/preflight
   digest binding to the release SHA. Preserve output and workflow URLs.
5. **Docker:** run `scripts/container-registry-readback.mjs` against
   GHCR, Docker Hub, and the repository's `VERCEL_VCR_IMAGE`. Require exact
   default, slim, browser, and architecture images, matching platform descriptor
   sets, and only the three `extended-stable*` aliases at those immutable
   digests. Separately verify attestations in GHCR and Docker Hub. Require the
   successful `OpenClaw Release Publish` parent run and its completed Docker
   verification. The normal route finalizes afterward; an explicitly requested
   fast path may activate GitHub first. Repair aliases through current-main
   `Docker Channel Promotion` for the exact tag, without rebuilding.
6. **Recovery:** never republish. Use `promote_extended_stable` in the
   `openclaw/releases` dist-tag workflow for the root selector (an unsuffixed
   final patch `33+`) and approved credential-isolated tooling for others, then repeat
   complete readback. Do not require ClawHub, native/mobile apps, website,
   private dist-tags, or regular `latest`. Require shared release evidence, but
   do not require regular native or ClawHub assets.
