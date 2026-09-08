# Extended-stable publication

When asked to create the initial `.33` extended-stable line or a later
maintenance patch, read
`backport-discovery.md` and
`extended-stable-backports.md` and follow both before version, tag,
or publication work. Treat backport discovery and preparation as an ability of
this release skill, not as a separate release workflow.

The backport flow covers mainline inventory, private-security reconciliation,
approval, the staging PR, and proof handoff. After it lands, use the shared
release pipeline with the extended-stable track inputs below.

Extended-stable requires a visible **SDK/config backport warning** whenever a
candidate changes the public plugin SDK or a config/default/schema/migration
surface. Prefer an adaptation that uses the SDK and configuration already
shipped on that line. If a contract change remains necessary, record its
published impact and the maintainer decision in the ledger and staging PR.
Read `extended-stable-backports.md`; a clean cherry-pick, green
release checks, or a regenerated baseline does not by itself explain the
maintenance risk.

Use this path only for the trailing completed month's `.33+` Gateway
distribution: the `openclaw` npm package, official npm plugins, and matching
Docker Gateway images. Treat
`docs/reference/RELEASING.md`,
`scripts/openclaw-npm-extended-stable-release.mjs`, and the release workflows
on pinned current `main` as the exact command and validation contract.

1. On `extended-stable/YYYY.M.33`, verify the root and every publishable official
   plugin have the intended version. Generate and commit the complete
   `## YYYY.M.P` changelog section with `### Highlights`, `### Changes`, and
   `### Fixes`. Carry the full current-main Docker
   release-channel unit: workflow, promoter, policy, shared classifier, tests,
   and workflow validation. Run focused checks and freeze the untagged tip SHA.
2. Keep the frozen SHA and canonical branch as the validation target; Full
   Release Validation derives `npm_dist_tag=extended-stable` from the version.
3. Run complete Full Release Validation against the canonical branch with
   `release_profile=stable`; save its run ID and successful `run_attempt`.
   Use the trusted main-pinned helper's canonical `release-ci/*` producer,
   which attests the immutable target SHA in its manifest. Direct branch/main
   producers do not satisfy protected-tag shared publication. Current manifests include qualified npm and prepared
   Docker artifacts; use that same run ID for npm preflight evidence. Historical
   manifests without them still need a separate npm preflight. Any candidate
   branch change invalidates both gates.
4. Require the tip still equals the frozen SHA, then create signed `vYYYY.M.P`.
   Never move or delete a final tag; later source changes need a new patch.
5. Require the saved validation run to be complete and successful, bind its
   manifest target SHA and attempt to the tag, and require the canonical
   `release-ci/<sha12>-<epoch>` producer with trusted tooling identity. Reject
   direct canonical-branch/main producers and narrow reruns.
6. With publication/tag-push authority, create and push a protected lightweight
   `release-publish/<tooling-sha12>-<epoch>` tag at the frozen trusted-main
   Tooling SHA, using the commands in `docs/reference/RELEASING.md`. Dispatch
   `OpenClaw Release Publish` with `--ref` set to that tooling tag, the product
   release tag as `tag`, `npm_dist_tag=extended-stable`,
   `publish_openclaw_npm=true`, the saved
   preflight and Full Release Validation run IDs, and the saved validation run
   attempt. The parent derives `release_candidate_branch`, creates the draft,
   publishes every official npm plugin and core under `extended-stable`,
   attaches release evidence, skips ClawHub/native publication, publishes
   Docker, and finalizes the release with `latest=false`.
7. If core npm already published, resume the parent from the same protected
   tooling tag with `openclaw_npm_resume_run_id` bound to the successful original core publish.
   It verifies the registry tarball against preflight before resuming evidence,
   Docker, and finalization. Docker-only recovery may dispatch from `main` with
   `publish_openclaw_npm=false` and `publish_docker_only=true`; that path does
   not attach evidence or finalize the release.
8. From a clean current-`main` checkout, run
   `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P`.
   Verify signatures, provenance, inventories, exact versions, and selectors.
   Use the generated repair only for the root selector; repair other selectors
   with approved credential-isolated tooling. Never republish a version.
9. Require `Docker Release` to verify default, slim, browser, and architecture
   images in GHCR and Docker Hub, including attestations and platform versions.
   It must advance only
   `extended-stable`, `extended-stable-slim`, and `extended-stable-browser` by
   digest and refuse automatic rollback. For alias repair, dispatch the
   approval-gated `docker-channel-promote.yml` from current `main` with the exact
   tag; never rebuild or move the release tag.
10. Verify the non-Latest GitHub Release and its dependency, validation, and
    postpublish evidence. Do not publish macOS, Windows, mobile, website,
    ClawHub, regular npm `latest`, or private dist-tag artifacts from this path.
